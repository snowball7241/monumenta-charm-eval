#include "common/aligned_eval.h"
#include "common/charm.h"
#include "common/eval.h"
#include "common/gen/charm_data.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <numeric>
#include <span>
#include <thread>
#include <vector>

// Branch-and-bound charm evaluator.
//
// Searches the same space as `naive` (all sets of <= CHARM_COUNT_MAX charms within max_cp, never a charm together with its own
// upgraded copy) and scores with the exact same integer utility function, so it returns the same optimal utility. It differs in that
// every node computes an optimistic upper bound on what its subtree could still reach, and the subtree is skipped when that bound
// cannot beat the best set found so far (shared across all worker threads).
//
// Notation: t = current stat totals, r_j = max(0, SCALE - t_j) = room left under effect j's cap, s_ij = charm i's stat j, and
// s+ / s- the positive / negative parts. For any set S of further charms, the utility gain is at most
//
//     sum_{w_j > 0} w_j * min(r_j, sum_{i in S} s+_ij)  +  sum_{w_j < 0} |w_j| * sum_{i in S} s-_ij          (*)
//
// (min(x, cap) is concave and nondecreasing, so negative stats can only lower positively weighted effects, and lowering a
// negatively weighted effect gains at most |w| per unit.) Splitting (*) into per-charm optimistic gains
//
//     g_i = sum_{w_j > 0} w_j * min(r_j, s+_ij)  +  sum_{w_j < 0} |w_j| * s-_ij
//
// can only overestimate, so the best possible S is bounded by a tiny 0/1 knapsack over the g_i: at most `slots_left` charms within
// the remaining charm power, solved exactly by DP over (count <= 7, cp <= 15). Respecting charm power is what makes the bound
// tight: top charms are usually the expensive ones, and far fewer of them fit than there are slots. A cheaper top-k sum that
// ignores charm power is tried first.
//
// (A per-effect bound, letting each effect pick its best contributions and then applying the cap, was also tried; it never cut a
// subtree the knapsack bound had not already cut, so it was dropped.)
//
// Charm stats are stored sparsely (each charm touches only a handful of the weighted effects), and the utility is maintained
// incrementally, so per-node work scales with the charms' nonzero stats rather than with the number of weighted effects.
//
// Upgrades: each upgraded "(u)" charm in a set costs `upgrade_penalty` utility, and a set may hold at most `max_upgrades` of them.
// Both fold into the search directly: the penalty is subtracted from that charm's exact and optimistic gains (so g_i stays a valid
// upper bound), and once the upgrade budget is used up, "(u)" charms are no longer candidates. The knapsack bound ignores the
// upgrade budget, which only makes it looser, never invalid.
//
// Charms are visited in decreasing order of root gain per charm power so that strong sets are found early.

namespace mtce
{
    using vec::ENCODED_CHARM_STAT_SCALE;

    namespace
    {
        constexpr int64_t CAP = ENCODED_CHARM_STAT_SCALE;

        struct entry
        {
            uint32_t effect;
            int32_t value;
        };

        struct bnb_problem
        {
            std::size_t n = 0;                   // charm count (after filtering)
            std::size_t d = 0;                   // weighted effect count (after filtering)
            std::vector<int64_t> weights;        // d
            std::vector<uint32_t> row_begin;     // n + 1; charm i's nonzero stats are entries[row_begin[i] .. row_begin[i + 1])
            std::vector<entry> entries;          // normalized like `naive`
            std::vector<uint32_t> cp;            // n
            std::vector<std::size_t> group;      // n; a charm and its "(u)" copy share a group and are mutually exclusive
            std::vector<charm_id> original;      // n; index into eval_config::charms
            std::vector<uint8_t> upgrade;        // n; 1 for an upgraded "(u)" charm
            uint32_t max_cp = 0;
            uint32_t max_upgrades = CHARM_COUNT_MAX;
            int64_t upgrade_penalty = 0;

            [[nodiscard]] auto penalty(std::size_t i) const -> int64_t { return upgrade[i] != 0 ? upgrade_penalty : 0; }

            [[nodiscard]] auto row(std::size_t i) const -> std::span<const entry>
            {
                return {entries.data() + row_begin[i], entries.data() + row_begin[i + 1]};
            }

            // exact utility change from adding charm i on top of totals t
            [[nodiscard]] auto exact_gain(std::size_t i, const int32_t* t) const -> int64_t
            {
                int64_t gain = 0;
                for (const auto [j, v] : row(i))
                {
                    gain += weights[j] * (std::min<int64_t>((int64_t)t[j] + v, CAP) - std::min<int64_t>(t[j], CAP));
                }
                return gain;
            }

            // optimistic gain g_i from the header comment
            [[nodiscard]] auto optimistic_gain(std::size_t i, const int32_t* t) const -> int64_t
            {
                int64_t gain = 0;
                for (const auto [j, v] : row(i))
                {
                    const int64_t w = weights[j];
                    if (w > 0 && v > 0)
                    {
                        gain += w * std::min<int64_t>(v, std::max<int64_t>(0, CAP - t[j]));
                    }
                    else if (w < 0 && v < 0)
                    {
                        gain += w * v;
                    }
                }
                return gain;
            }
        };

        // same filtering + normalization as `naive`: drop unweighted effects and charms that touch no weighted effect
        auto prepare(const eval_config& config) -> bnb_problem
        {
            std::vector<std::size_t> abilities;
            for (std::size_t ability = 0; ability < ABILITY_COUNT; ability++)
            {
                if (config.weights.at(ability) == 0)
                {
                    continue;
                }

                if (std::ranges::any_of(config.charms, [&](const charm& c) { return c.charm_data.at(ability) != 0; }))
                {
                    abilities.push_back(ability);
                }
            }

            // read_charms() emits an upgradable charm immediately followed by its "(u)" copy
            std::vector<std::size_t> group_of(config.charms.size());
            for (std::size_t i = 0; i < config.charms.size(); i++)
            {
                group_of[i] = (i > 0 && config.charms[i - 1].has_upgrade) ? group_of[i - 1] : i;
            }

            struct staged
            {
                std::vector<entry> stats;
                uint32_t cp;
                std::size_t group;
                charm_id original;
                bool upgrade;
                int64_t root_gain = 0;
            };

            std::vector<int64_t> weights;
            weights.reserve(abilities.size());
            for (const auto ability : abilities)
            {
                weights.push_back(config.weights.at(ability));
            }

            std::vector<staged> charms;
            for (std::size_t i = 0; i < config.charms.size(); i++)
            {
                const auto& c = config.charms[i];
                staged s{.stats = {}, .cp = c.charm_power, .group = group_of[i], .original = (charm_id)i, .upgrade = c.is_upgrade};

                // with no upgrade budget an upgraded charm can never be used
                if (s.upgrade && config.max_upgrades == 0)
                {
                    continue;
                }

                for (std::size_t j = 0; j < abilities.size(); j++)
                {
                    const auto raw = c.charm_data.at(abilities[j]);
                    if (raw == 0)
                    {
                        continue;
                    }
                    const auto rel_value = raw / EFFECT_CAPS.at(abilities[j]);
                    s.stats.push_back({.effect = (uint32_t)j, .value = (int32_t)(rel_value * ENCODED_CHARM_STAT_SCALE)});
                }

                if (s.stats.empty())
                {
                    continue;
                }

                for (const auto [j, v] : s.stats)
                {
                    if (weights[j] > 0 && v > 0)
                    {
                        s.root_gain += weights[j] * std::min<int64_t>(v, CAP);
                    }
                    else if (weights[j] < 0 && v < 0)
                    {
                        s.root_gain += weights[j] * v;
                    }
                }
                if (s.upgrade)
                {
                    s.root_gain -= upgrade_penalty_to_utility(config.upgrade_penalty);
                }

                charms.push_back(std::move(s));
            }

            // visit order: most promising (root gain per charm power) first
            std::ranges::stable_sort(charms, [](const staged& a, const staged& b) {
                const auto cpa = std::max<int64_t>(a.cp, 1);
                const auto cpb = std::max<int64_t>(b.cp, 1);
                return (__int128)a.root_gain * cpb > (__int128)b.root_gain * cpa;
            });

            bnb_problem p;
            p.max_cp = config.max_cp;
            p.max_upgrades = config.max_upgrades;
            p.upgrade_penalty = upgrade_penalty_to_utility(config.upgrade_penalty);
            p.n = charms.size();
            p.d = abilities.size();
            p.weights = std::move(weights);
            p.row_begin.push_back(0);
            for (const auto& c : charms)
            {
                p.entries.insert(p.entries.end(), c.stats.begin(), c.stats.end());
                p.row_begin.push_back((uint32_t)p.entries.size());
                p.cp.push_back(c.cp);
                p.group.push_back(c.group);
                p.original.push_back(c.original);
                p.upgrade.push_back(c.upgrade ? 1 : 0);
            }

            return p;
        }

        struct shared_state
        {
            std::atomic<int64_t> best{0}; // the empty set scores 0, matching `naive`
            std::atomic<std::size_t> next_job{0};
        };

        struct worker
        {
            const bnb_problem& p;
            shared_state& shared;

            int64_t best_utility = -1;
            std::array<std::size_t, CHARM_COUNT_MAX> best_set{};
            std::size_t best_size = 0;

            std::array<std::size_t, CHARM_COUNT_MAX> set{};
            std::array<std::size_t, CHARM_COUNT_MAX> groups{};
            std::size_t size = 0;
            uint32_t upgrades = 0; // "(u)" charms in the current set

            std::vector<int32_t> totals;

            // scratch for the bounds
            struct candidate
            {
                uint32_t index;
                uint32_t cp;
                int64_t gain;
            };
            std::vector<candidate> candidates;
            std::vector<int64_t> gain_buf;

            bnb_stats stats{};

            worker(const bnb_problem& prob, shared_state& sh) : p(prob), shared(sh), totals(p.d, 0)
            {
                candidates.reserve(p.n);
                gain_buf.reserve(p.n);
            }

            [[nodiscard]] auto group_used(std::size_t g) const -> bool
            {
                for (std::size_t k = 0; k < size; k++)
                {
                    if (groups[k] == g)
                    {
                        return true;
                    }
                }
                return false;
            }

            // can charm i join the current set? (charm power, not alongside its own base/upgraded copy, upgrade budget)
            [[nodiscard]] auto allowed(std::size_t i, uint32_t curr_cp) const -> bool
            {
                return curr_cp + p.cp[i] <= p.max_cp && (p.upgrade[i] == 0 || upgrades < p.max_upgrades) && !group_used(p.group[i]);
            }

            // utility change from adding charm i, including its upgrade penalty
            [[nodiscard]] auto child_gain(std::size_t i) const -> int64_t { return p.exact_gain(i, totals.data()) - p.penalty(i); }

            void publish(int64_t utility)
            {
                int64_t global = shared.best.load(std::memory_order_relaxed);
                while (utility > global && !shared.best.compare_exchange_weak(global, utility, std::memory_order_relaxed))
                {
                }
            }

            void record(int64_t utility)
            {
                if (utility > best_utility)
                {
                    best_utility = utility;
                    best_set = set;
                    best_size = size;
                    publish(utility);
                }
            }

            void push(std::size_t i)
            {
                for (const auto [j, v] : p.row(i))
                {
                    totals[j] += v;
                }
                set[size] = i;
                groups[size] = p.group[i];
                upgrades += p.upgrade[i];
                size++;
            }

            void pop()
            {
                size--;
                upgrades -= p.upgrade[set[size]];
                for (const auto [j, v] : p.row(set[size]))
                {
                    totals[j] -= v;
                }
            }

            // best <= slots charms within cp_left, by per-charm optimistic gain (exact 0/1 knapsack on the relaxation)
            [[nodiscard]] auto knapsack_bound(std::size_t slots, uint32_t cp_left) const -> int64_t
            {
                std::array<std::array<int64_t, CHARM_POWER_MAX + 1>, CHARM_COUNT_MAX + 1> dp{};
                for (const auto& c : candidates)
                {
                    for (std::size_t k = slots; k >= 1; k--)
                    {
                        for (uint32_t b = cp_left; b >= c.cp && b <= cp_left; b--)
                        {
                            dp[k][b] = std::max(dp[k][b], dp[k - 1][b - c.cp] + c.gain);
                            if (b == 0)
                            {
                                break;
                            }
                        }
                    }
                }
                return dp[slots][cp_left];
            }

            // the current set's totals are in `totals`; `start` is the first candidate position
            void search(int64_t utility, uint32_t curr_cp, std::size_t start)
            {
                stats.visited++;
                record(utility);

                const std::size_t slots_left = CHARM_COUNT_MAX - size;
                if (slots_left == 0)
                {
                    return;
                }

                // last slot: scoring each child exactly is as cheap as bounding it, so do that without recursing
                if (slots_left == 1)
                {
                    for (std::size_t i = start; i < p.n; i++)
                    {
                        if (!allowed(i, curr_cp))
                        {
                            continue;
                        }
                        stats.visited++;
                        const auto child = utility + child_gain(i);
                        if (child > best_utility)
                        {
                            set[size] = i;
                            size++;
                            record(child);
                            size--;
                        }
                    }
                    return;
                }

                const uint32_t cp_left = p.max_cp - curr_cp;
                candidates.clear();
                gain_buf.clear();
                for (std::size_t i = start; i < p.n; i++)
                {
                    if (allowed(i, curr_cp))
                    {
                        const auto gain = p.optimistic_gain(i, totals.data()) - p.penalty(i);
                        if (gain > 0)
                        {
                            candidates.push_back({.index = (uint32_t)i, .cp = p.cp[i], .gain = gain});
                            gain_buf.push_back(gain);
                        }
                    }
                }

                const int64_t need = shared.best.load(std::memory_order_relaxed) - utility; // must be able to gain more than this

                // cheapest first: top-k per-charm gains, ignoring charm power
                const auto take = std::min(slots_left, gain_buf.size());
                std::partial_sort(gain_buf.begin(), gain_buf.begin() + (std::ptrdiff_t)take, gain_buf.end(), std::greater<>());
                if (std::accumulate(gain_buf.begin(), gain_buf.begin() + (std::ptrdiff_t)take, int64_t{0}) <= need)
                {
                    stats.pruned++;
                    return;
                }

                // then the exact charm-power-aware bound
                if (knapsack_bound(slots_left, cp_left) <= need)
                {
                    stats.pruned++;
                    stats.pruned_knapsack++;
                    return;
                }

                for (std::size_t i = start; i < p.n; i++)
                {
                    if (!allowed(i, curr_cp))
                    {
                        continue;
                    }

                    const auto child = utility + child_gain(i);
                    push(i);
                    search(child, curr_cp + p.cp[i], i + 1);
                    pop();
                }
            }

            // each job is "the first charm of the set is at sorted position `first`"
            void run()
            {
                while (true)
                {
                    const auto first = shared.next_job.fetch_add(1, std::memory_order_relaxed);
                    if (first >= p.n)
                    {
                        return;
                    }

                    if (!allowed(first, 0))
                    {
                        continue;
                    }

                    const auto utility = child_gain(first);
                    push(first);
                    search(utility, p.cp[first], first + 1);
                    pop();
                }
            }
        };
    } // namespace

    auto evaluate_bnb(const eval_config& config, const bnb_tracing_config& trace) -> eval_result
    {
        const auto problem = prepare(config);
        shared_state shared;

        const auto n_threads = std::max<std::size_t>(config.threads, 1);
        std::vector<worker> workers;
        workers.reserve(n_threads);
        for (std::size_t t = 0; t < n_threads; t++)
        {
            workers.emplace_back(problem, shared);
        }

        if (n_threads == 1)
        {
            workers[0].run();
        }
        else
        {
            std::vector<std::thread> threads;
            threads.reserve(n_threads);
            for (auto& w : workers)
            {
                threads.emplace_back([&w]() { w.run(); });
            }
            for (auto& t : threads)
            {
                t.join();
            }
        }

        // the empty set (utility 0) is the fallback, as in `naive`
        int64_t best_utility = 0;
        const worker* best = nullptr;
        bnb_stats total{.charms = problem.n, .effects = problem.d, .visited = 1}; // root

        for (const auto& w : workers)
        {
            total.visited += w.stats.visited;
            total.pruned += w.stats.pruned;
            total.pruned_knapsack += w.stats.pruned_knapsack;
            if (w.best_utility > best_utility)
            {
                best_utility = w.best_utility;
                best = &w;
            }
        }

        if (trace.trace_stats)
        {
            trace.trace_stats(total);
        }

        eval_result result{.utility_value = best_utility, .charms = {}};
        if (best != nullptr)
        {
            for (std::size_t k = 0; k < best->best_size; k++)
            {
                result.charms.push_back(problem.original[best->best_set[k]]);
            }
        }

        return result;
    }
} // namespace mtce
