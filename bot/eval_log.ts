import {appendFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {logger} from "./log";

// Replay log: one JSON object per line in audit/evals.jsonl, written after every evaluation. Each record is self-contained
// (weights snapshot, exact charm lines, options, result, timing), so requests can be re-run later even after configs are
// edited or Discord attachment links expire. `npx tsx replay.ts` re-runs them to compare algorithms (see replay.ts).
//
// The log holds Discord user ids and users' charm data; audit/ is git-ignored.

export const EVAL_LOG_PATH = "audit/evals.jsonl";

export interface MtceRunOptions {
    weights: Record<string, string>;
    cp: number;
    maxUpgrades?: number;
    upgradePenalty?: number;
}

export type Algo = "bnb" | "naive";

// The single place mtce's command line is built, shared by the bot and the replay script so both run the same request.
// `progress` asks bnb for "progress <fraction>" lines on stderr (the bot shows them in /queue; replay leaves it off).
export function buildMtceArgs(opts: MtceRunOptions, charmsFile: string, algo: Algo, threads: number, progress = false): string[] {
    return [
        "--bot-mode", "--in", charmsFile,
        "--algo", algo, `--${algo}-threads`, threads.toString(),
        ...(progress && algo === "bnb" ? ["--bnb-progress"] : []),
        "--config-charm-power", opts.cp.toString(),
        ...(opts.maxUpgrades !== undefined ? ["--config-max-upgrades", opts.maxUpgrades.toString()] : []),
        ...(opts.upgradePenalty !== undefined ? ["--config-upgrade-penalty", opts.upgradePenalty.toString()] : []),
        ...Object.entries(opts.weights).flatMap(([k, v]) => [`--weight-${k}`, v.toString()])
    ];
}

export interface MtceIdentity {
    version: string; // first line of `mtce --version`
    sha256: string;  // of the binary: identifies the exact build
}

const identityCache = new Map<string, MtceIdentity>();

export function mtceIdentity(binary: string): MtceIdentity {
    const cached = identityCache.get(binary);
    if (cached !== undefined) {
        return cached;
    }

    let identity: MtceIdentity;
    try {
        const firstLine = spawnSync(binary, ["--version"], {encoding: "utf8", }).stdout.split("\n")[0].trim();
        const version = firstLine.replace(/^.*version\s+/, ""); // "./mtce: version 1.0.0" -> "1.0.0"
        const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
        identity = {version, sha256, };
    } catch {
        identity = {version: "unknown", sha256: "unknown", };
    }

    identityCache.set(binary, identity);
    return identity;
}

export interface EvalLogRecord extends MtceRunOptions {
    v: 1;
    time: string;           // ISO timestamp when mtce started
    creator: string;        // Discord user id that asked
    configOwner: string;
    configName: string;
    charms: string[];       // exact lines given to mtce
    algo: Algo;
    threads: number;
    mtce: MtceIdentity;
    elapsedMs: number;      // wall time of the mtce process
    result:
        | {ok: true; weight: string; charms: number[]}
        | {ok: false; error: string};
}

export async function appendEvalRecord(record: EvalLogRecord, path = EVAL_LOG_PATH) {
    try {
        await appendFile(path, JSON.stringify(record) + "\n");
    } catch (e) {
        // never fail an evaluation because the log could not be written
        logger.error("could not write eval log", e);
    }
}

export function readEvalLog(path = EVAL_LOG_PATH): EvalLogRecord[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(line => line.trim().length > 0)
        .map((line, i) => {
            try {
                return JSON.parse(line) as EvalLogRecord;
            } catch {
                throw new Error(`${path}: line ${i + 1} is not valid JSON`);
            }
        });
}
