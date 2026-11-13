// Re-runs logged bot requests (audit/evals.jsonl) with both algorithms and compares them.
//
//   npx tsx replay.ts [options]
//     --log <path>           replay log (default audit/evals.jsonl)
//     --mtce <path>          mtce binary (default ./mtce)
//     --algos <list>         comma-separated algorithms to run (default bnb,naive)
//     --threads <n>          threads per run (default: all cores)
//     --timeout <seconds>    per-run limit; naive can take hours on big inputs (default 120)
//     --all                  also replay duplicates (by default identical requests, e.g. /rerun, are replayed once)
//     --last <n>             only the n most recent requests
//     --csv <path>           also write the per-request results as CSV
//
// For each request it reports both algorithms' score and time, whether they agree, and whether they still match the score the
// bot logged at the time (catches regressions between mtce builds). Exits with status 1 if any scores disagree.
// Run it while the bot is idle: both compete for the same CPU cores.

import {createHash} from "node:crypto";
import {availableParallelism} from "node:os";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {performance} from "node:perf_hooks";
import {Algo, buildMtceArgs, EvalLogRecord, EVAL_LOG_PATH, mtceIdentity, readEvalLog} from "./eval_log";

function parseArgs(argv: string[]) {
    const opts = {
        log: EVAL_LOG_PATH,
        mtce: "./mtce",
        algos: ["bnb", "naive"] as Algo[],
        threads: availableParallelism(),
        timeoutSec: 120,
        all: false,
        last: Infinity,
        csv: undefined as string | undefined,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) {
                throw new Error(`${arg} needs a value`);
            }
            return v;
        };

        switch (arg) {
        case "--log": opts.log = value(); break;
        case "--mtce": opts.mtce = value(); break;
        case "--algos": opts.algos = value().split(",").map(a => {
            if (a !== "bnb" && a !== "naive") throw new Error(`unknown algorithm ${a}`);
            return a;
        }); break;
        case "--threads": opts.threads = Number(value()); break;
        case "--timeout": opts.timeoutSec = Number(value()); break;
        case "--all": opts.all = true; break;
        case "--last": opts.last = Number(value()); break;
        case "--csv": opts.csv = value(); break;
        case "--help": case "-h":
            console.log("usage: npx tsx replay.ts [--log path] [--mtce path] [--algos bnb,naive] [--threads n] [--timeout s] [--all] [--last n] [--csv path]");
            process.exit(0);
            break;
        default:
            throw new Error(`unknown option ${arg} (try --help)`);
        }
    }

    return opts;
}

type RunResult = {status: "ok"; utility: bigint; ms: number} | {status: "timeout"; ms: number} | {status: "error"; message: string; ms: number};

function runMtce(mtce: string, record: EvalLogRecord, charmsFile: string, algo: Algo, threads: number, timeoutSec: number): RunResult {
    const args = buildMtceArgs(record, charmsFile, algo, threads);
    const start = performance.now();
    const proc = spawnSync(mtce, args, {encoding: "utf8", timeout: timeoutSec * 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, });
    const ms = performance.now() - start;

    if ((proc.error !== undefined && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT") || proc.signal === "SIGKILL") {
        return {status: "timeout", ms, };
    }
    if (proc.error !== undefined) {
        return {status: "error", message: proc.error.message, ms, };
    }
    if (proc.status !== 0) {
        return {status: "error", message: (proc.stderr || proc.stdout).trim().split("\n")[0] || `exit ${proc.status}`, ms, };
    }

    try {
        return {status: "ok", utility: BigInt(proc.stdout.split("\n")[0].trim()), ms, };
    } catch {
        return {status: "error", message: "unparseable output", ms, };
    }
}

function requestKey(r: EvalLogRecord): string {
    return createHash("sha256")
        .update(JSON.stringify([r.charms, Object.entries(r.weights).sort(), r.cp, r.maxUpgrades ?? null, r.upgradePenalty ?? null]))
        .digest("hex");
}

const fmtMs = (ms: number) => ms < 1000 ? `${ms.toFixed(1)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 60000).toFixed(1)} min`;
const fmtRun = (r: RunResult | undefined) => r === undefined ? "-" : r.status === "ok" ? fmtMs(r.ms) : r.status === "timeout" ? `>${fmtMs(r.ms)} (timeout)` : `error: ${r.message}`;

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const all = readEvalLog(opts.log);

    // newest last; keep the latest occurrence of identical requests unless --all
    const seen = new Set<string>();
    let records = opts.all ? all : all.slice().reverse().filter(r => {
        const key = requestKey(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).reverse();
    if (Number.isFinite(opts.last)) {
        records = records.slice(-opts.last);
    }

    const identity = mtceIdentity(opts.mtce);
    console.log(`replaying ${records.length} request(s) from ${opts.log} (${all.length} logged${opts.all ? "" : `, ${all.length - seen.size} duplicate(s) skipped`})`);
    console.log(`mtce: ${opts.mtce} [${identity.version}, ${identity.sha256.slice(0, 12)}], algorithms: ${opts.algos.join(" vs ")}, ${opts.threads} thread(s), timeout ${opts.timeoutSec}s per run\n`);

    const dir = mkdtempSync(join(tmpdir(), "mtce-replay-"));
    const rows: string[][] = [];
    let mismatches = 0, timeouts = 0, errors = 0, logDrift = 0;
    const speedups: number[] = [];

    try {
        records.forEach((record, i) => {
            const file = join(dir, `charms-${i}.txt`);
            writeFileSync(file, record.charms.join("\n"));

            const runs = new Map<Algo, RunResult>();
            for (const algo of opts.algos) {
                runs.set(algo, runMtce(opts.mtce, record, file, algo, opts.threads, opts.timeoutSec));
            }

            const okUtilities = [...runs.values()].filter(r => r.status === "ok").map(r => (r as {utility: bigint}).utility);
            const agree = okUtilities.every(u => u === okUtilities[0]);
            const logged = record.result.ok ? BigInt(record.result.weight) : undefined;
            // a result logged as incomplete (bot time limit) may be below the optimum, so it can't be compared
            const loggedComplete = record.result.ok && record.result.complete !== false;
            const matchesLog = logged === undefined || !loggedComplete || okUtilities.length === 0 || okUtilities[0] === logged;

            if (!agree) mismatches++;
            if (!matchesLog) logDrift++;
            for (const r of runs.values()) {
                if (r.status === "timeout") timeouts++;
                if (r.status === "error") errors++;
            }

            const bnb = runs.get("bnb"), naive = runs.get("naive");
            let speedup = "";
            if (bnb?.status === "ok" && naive?.status === "ok") {
                const s = naive.ms / Math.max(bnb.ms, 0.001);
                speedups.push(s);
                speedup = `${s.toFixed(1)}x`;
            } else if (bnb?.status === "ok" && naive?.status === "timeout") {
                speedup = `>${(naive.ms / Math.max(bnb.ms, 0.001)).toFixed(0)}x`;
            }

            const verdict = !agree ? "MISMATCH" : !matchesLog ? "differs from logged" : okUtilities.length === 0 ? "no result" : "ok";
            const upgrades = [record.maxUpgrades !== undefined ? `max ${record.maxUpgrades}` : "", record.upgradePenalty ? `pen ${record.upgradePenalty}` : ""].filter(Boolean).join(", ");

            console.log(
                `#${i + 1} ${record.time.slice(0, 16).replace("T", " ")} ${record.configName} | ${record.charms.length} charm lines, ` +
                `${Object.keys(record.weights).length} weights, cp ${record.cp}${upgrades ? ", " + upgrades : ""}\n` +
                opts.algos.map(a => `    ${a.padEnd(5)} ${fmtRun(runs.get(a)).padEnd(24)} ${runs.get(a)?.status === "ok" ? (runs.get(a) as {utility: bigint}).utility : ""}`).join("\n") +
                `\n    logged ${record.result.ok ? `${fmtMs(record.elapsedMs)} (${record.algo})`.padEnd(24) + " " + record.result.weight + (loggedComplete ? "" : " (incomplete: hit the bot's time limit)") : "error: " + record.result.error}` +
                `\n    => ${verdict}${speedup ? `, bnb ${speedup} faster` : ""}\n`
            );

            rows.push([
                record.time, record.configOwner, record.configName, String(record.charms.length), String(Object.keys(record.weights).length),
                String(record.cp), String(record.maxUpgrades ?? ""), String(record.upgradePenalty ?? ""),
                ...opts.algos.flatMap(a => {
                    const r = runs.get(a);
                    return [r?.status ?? "", r?.status === "ok" ? String(r.utility) : "", r ? r.ms.toFixed(1) : ""];
                }),
                logged?.toString() ?? "", String(record.elapsedMs), verdict
            ]);
        });
    } finally {
        rmSync(dir, {recursive: true, force: true, });
    }

    if (opts.csv !== undefined) {
        const header = ["time", "config_owner", "config_name", "charm_lines", "weights", "cp", "max_upgrades", "upgrade_penalty",
            ...opts.algos.flatMap(a => [`${a}_status`, `${a}_utility`, `${a}_ms`]), "logged_utility", "logged_ms", "verdict"];
        writeFileSync(opts.csv, [header, ...rows].map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, "\"\"")}"` : c).join(",")).join("\n") + "\n");
        console.log(`wrote ${opts.csv}`);
    }

    const geomean = speedups.length > 0 ? Math.exp(speedups.reduce((s, x) => s + Math.log(x), 0) / speedups.length) : undefined;
    const sorted = speedups.slice().sort((a, b) => a - b);
    console.log(
        `summary: ${records.length} request(s), ${mismatches} score mismatch(es), ${timeouts} timeout(s), ${errors} error(s)` +
        (logDrift > 0 ? `, ${logDrift} differ from the score logged at the time` : "") +
        (geomean !== undefined ? `\nbnb vs naive (where both finished, n=${speedups.length}): geometric mean ${geomean.toFixed(1)}x faster, ` +
            `range ${sorted[0].toFixed(1)}x - ${sorted[sorted.length - 1].toFixed(1)}x` : "")
    );

    process.exit(mismatches > 0 ? 1 : 0);
}

main();
