#pragma once

#include "aligned_eval.h"
#include "charm.h"
#include "gen/charm_data.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <chrono>
#include <functional>
#include <string_view>
#include <vector>

namespace mtce
{
    using charm_weights = std::array<std::int32_t, ABILITY_COUNT>;

    struct eval_config
    {
        std::vector<charm> charms;
        uint32_t max_cp;
        charm_weights weights;
        std::size_t threads;
        // upgrades ("(u)" charms) are expensive in game: cap how many a set may use, and/or charge a utility cost for each
        uint32_t max_upgrades = CHARM_COUNT_MAX;
        int32_t upgrade_penalty = 0; // in weight units, as written in the config; see upgrade_penalty_to_utility()
    };

    // The config's `upgrade_penalty = P` means "one upgrade costs as much as an effect with weight P going from 0 to its cap". In
    // internal utility units (weight * capped stat, a full cap being ENCODED_CHARM_STAT_SCALE) that is P * scale; it is rounded down to
    // a multiple of CHARM_COUNT_MAX (a relative error of ~5e-8) because `naive` implements the penalty as a hidden stat column holding
    // scale / CHARM_COUNT_MAX per upgrade, and both algorithms must score identically.
    inline constexpr int32_t UPGRADE_PENALTY_COLUMN_VALUE = vec::ENCODED_CHARM_STAT_SCALE / CHARM_COUNT_MAX;

    constexpr auto upgrade_penalty_to_utility(int32_t penalty) -> int64_t
    {
        return (int64_t)penalty * CHARM_COUNT_MAX * UPGRADE_PENALTY_COLUMN_VALUE;
    }

    struct eval_result
    {
        int64_t utility_value;
        std::vector<charm_id> charms;
    };

    struct naive_tracing_config 
    {
        std::function<void(std::vector<std::string_view>& abilities, std::vector<std::string_view>& charms)> trace_prune;
    };

    auto evaluate_naive(const eval_config& config, const naive_tracing_config& trace = {}) -> eval_result;

    struct bnb_stats
    {
        std::size_t charms = 0;            // left after filtering
        std::size_t effects = 0;           // weighted effects left after filtering
        std::uint64_t visited = 0;         // charm sets scored
        std::uint64_t pruned = 0;          // subtrees cut by any bound
        std::uint64_t pruned_knapsack = 0; // ... of which only the charm-power-aware bound could cut
    };

    struct bnb_tracing_config
    {
        std::function<void(const bnb_stats& stats)> trace_stats;

        // Called every `progress_interval` while the search runs (from a separate thread), with the fraction of the search space
        // finished so far, in [0, 1]. The space is every set of up to 7 charms; a pruned subtree counts as finished all at once, so
        // this is a rough measure: it says how much is left, not how long that will take.
        std::function<void(double fraction)> progress;
        std::chrono::milliseconds progress_interval{1000};
    };

    auto evaluate_bnb(const eval_config& config, const bnb_tracing_config& trace = {}) -> eval_result;
} // namespace mtce
