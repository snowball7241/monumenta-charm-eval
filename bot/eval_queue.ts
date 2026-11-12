import {writeFile} from "node:fs/promises";
import {BlockingQueue} from "./blocking_queue";
import {spawn} from "node:child_process";
import {file as createTmpFile} from "tmp-promise";
import {logger} from "./log";
import {getConfig} from "./config";
import {stripVTControlCharacters} from "node:util";
import {performance} from "node:perf_hooks";
import {appendEvalRecord, buildMtceArgs, mtceIdentity} from "./eval_log";

const MTCE_BINARY = "./mtce";
const ALGO = "bnb";
const PROGRESS_INTERVAL_MS = 60 * 1000;

export function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Shared by the console progress lines and /queue so both say the same thing. `user` renders a Discord id
// (raw id on the console, a mention in Discord).
export function describeTask(task: CharmEvalTask, user: (id: string) => string = id => id): string {
    const extras = [
        `${task.charms.length} charms`, `cp ${task.cp}`,
        ...(task.upgrades.maxUpgrades !== undefined ? [`max ${task.upgrades.maxUpgrades} upgrades`] : []),
        ...(task.upgrades.upgradePenalty ? [`upgrade penalty ${task.upgrades.upgradePenalty}`] : [])
    ];
    return `${user(task.configOwner)}:${task.configName} for ${user(task.creator)} (${extras.join(", ")})`;
}

// mtce reports the share of possible charm sets it has dealt with ("searched"). That runs far behind the clock, because bnb spends
// most of its time on sets of strong charms and dismisses sets of weak charms almost instantly: halfway through a run it is
// typically at ~15%. Its cube root tracked elapsed time within ~8 percentage points on average on test runs (dawn configs and
// random ability-focused configs, 1 and 8 threads), so that is what's shown. It is a rough guide, not a promise.
export function estimatedDone(searched: number): number {
    return Math.min(0.99, Math.cbrt(Math.max(0, searched)));
}

export function runningStatus(task: RunningTask, waiting: number, user?: (id: string) => string): string {
    const done = task.searched !== undefined ? `, ~${Math.round(estimatedDone(task.searched) * 100)}% done` : "";
    return `still running after ${fmtElapsed(Date.now() - task.startTime)}${done}: ${describeTask(task, user)}, ${waiting} waiting`;
}

export type EvalResult = {
    success: true;
    weight: bigint;
    charms: number[];
    stats: string;      // plain text
    statsAnsi: string;  // mtce's original colored output (see ansi.ts for Discord rendering)
} | {
    success: false;
    error: string;
}

export interface CharmEvalTask {
    completionHandler: (result: EvalResult) => void;
    creator: string;
    configOwner: string;
    configName: string;
    weights: Record<string, string>;
    charms: string[];
    cp: number;
    upgrades: UpgradeOptions;
    creationTime: number;
}

export interface UpgradeOptions {
    maxUpgrades?: number;    // max upgraded "(u)" charms per set; undefined = no limit
    upgradePenalty?: number; // cost per upgraded charm, in weight units; undefined = 0
}

export interface RunningTask extends CharmEvalTask {
    startTime: number;
    searched?: number; // latest raw progress from mtce, in [0, 1]; see estimatedDone
}

interface SpawnResult {
    success: boolean;
    result: string | number | Error;
    stdout: Buffer;
    stderr: Buffer;
}

const PROGRESS_LINE = /^progress ([0-9.]+)$/;

async function doTask(task: CharmEvalTask, filePath: string, onProgress: (searched: number) => void): Promise<EvalResult> {
    await writeFile(filePath, task.charms.join("\n"));

    const spawnResult = await new Promise<SpawnResult>((resolve) => {
        const args = buildMtceArgs({weights: task.weights, cp: task.cp, ...task.upgrades, }, filePath, ALGO, getConfig().threads, true);

        logger.audit("eval_queue.spawn", {args, });

        const proc = spawn(MTCE_BINARY, args, {
            timeout: getConfig().timeout * 1000,
        });

        let stdout = Buffer.of();
        let stderr = Buffer.of();     // everything but progress lines (errors, for the audit log)
        let stderrPartial = "";       // an incomplete last line, until the rest arrives

        proc.addListener("close", (code, signal) => {
            if (code !== null) {
                resolve({success: code === 0, result: code, stdout, stderr, });
            } else if (signal !== null) {
                resolve({success: false, result: signal, stdout, stderr, });
            }
        });

        proc.addListener("error", error => {
            resolve({success: false, result: error, stdout, stderr, });
        });

        proc.stdout.on("data", (entry) => stdout = Buffer.concat([stdout, entry]));
        proc.stderr.on("data", (entry: Buffer) => {
            const lines = (stderrPartial + entry.toString("utf8")).split("\n");
            stderrPartial = lines.pop() ?? "";
            const kept = lines.filter(line => {
                const match = line.match(PROGRESS_LINE);
                if (match) {
                    onProgress(Number(match[1]));
                }
                return !match;
            });
            if (kept.length > 0) {
                stderr = Buffer.concat([stderr, Buffer.from(kept.join("\n") + "\n")]);
            }
        });
        proc.stderr.on("end", () => {
            if (stderrPartial.length > 0 && !PROGRESS_LINE.test(stderrPartial)) {
                stderr = Buffer.concat([stderr, Buffer.from(stderrPartial)]);
            }
        });
    });

    const auditLogCommon = {
        stdout: spawnResult.stdout.toString("utf8"),
        stderr: spawnResult.stderr.toString("utf8"),
    };

    if (!spawnResult.success) {

        if (typeof spawnResult.result === "number") {
            logger.audit("eval_queue.spawn.error.exit", {code: spawnResult.result, ...auditLogCommon, });
            return {
                success: false,
                error: `Exited with code ${spawnResult.result}.`,
            };
        } else if (typeof spawnResult.result === "string") {
            logger.audit("eval_queue.spawn.error.signal", {signal: spawnResult.result, ...auditLogCommon, });
            return {
                success: false,
                error: spawnResult.result === "SIGTERM" ? "Task timed out (try fewer charms?)." : `Signal received: ${spawnResult.result}, please report.`,
            };
        } else {
            logger.audit("eval_queue.spawn.error", {message: spawnResult.result, ...auditLogCommon, });
            logger.error(spawnResult.result);
            return {
                success: false,
                error: `Failed with error: ${spawnResult.result.message}.`,
            };
        }
    }

    const parts = spawnResult.stdout.toString("utf8").trim().split("\n\n");

    if (parts.length != 2) {
        return {
            success: false,
            error: "Internal error: illegal output from charm evaluator",
        };
    }

    const rawLines = parts[0].split("\n");

    if (rawLines.length < 1) {
        return {
            success: false,
            error: "Internal error: illegal output from charm evaluator",
        };
    }

    try {

        const result = {
            weight: BigInt(rawLines[0]),
            charms: rawLines.slice(1).map(x => parseInt(x)),
        };

        logger.audit("eval_queue.done", {...result, ...auditLogCommon, });

        return {
            success: true,
            stats: stripVTControlCharacters(parts[1]),
            statsAnsi: parts[1],
            ...result, 
        };
    } catch {
        return {
            success: false,
            error: "Internal error.",
        };
    }
}

export class EvalJobRunner {
    private queue = new BlockingQueue<CharmEvalTask>();
    private currTask?: RunningTask;

    public async begin() {
        while (true) {
            const task = await this.queue.poll();
            const running: RunningTask = {...task, startTime: Date.now(), };
            this.currTask = running;

            const charmsFile = await createTmpFile();
            const describe = describeTask(task);
            const start = performance.now();
            const elapsed = () => fmtElapsed(performance.now() - start);

            logger.info(`[eval] started ${describe}, ${this.queue.entries().length} waiting`);
            // progress line once per minute, so a long run is visibly still alive
            const progress = setInterval(() => {
                logger.info(`[eval] ${runningStatus(running, this.queue.entries().length)}`);
            }, PROGRESS_INTERVAL_MS);

            try {
                const startedAt = new Date();
                const result = await doTask(task, charmsFile.path, searched => running.searched = searched);
                clearInterval(progress);
                const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
                logger.info(`[eval] ${result.success ? "finished" : `failed (${result.error})`} after ${elapsed()}: ${describe}`);

                // log before replying, so a request is never answered but missing from the log
                await appendEvalRecord({
                    v: 1,
                    time: startedAt.toISOString(),
                    creator: task.creator,
                    configOwner: task.configOwner,
                    configName: task.configName,
                    weights: task.weights,
                    cp: task.cp,
                    ...task.upgrades,
                    charms: task.charms,
                    algo: ALGO,
                    threads: getConfig().threads,
                    mtce: mtceIdentity(MTCE_BINARY),
                    elapsedMs,
                    result: result.success ?
                        {ok: true, weight: result.weight.toString(), charms: result.charms, } :
                        {ok: false, error: result.error, },
                });

                task.completionHandler(result);
            } finally {
                clearInterval(progress);
                charmsFile.cleanup();
                this.currTask = undefined;
            }
        }
    }

    public evaluate(
        creator: string,
        configOwner: string,
        configName: string,
        weights: Record<string, string>, charms: string[], cp: number, upgrades: UpgradeOptions = {}
    ): Promise<EvalResult> {
        return new Promise((resolve) => {
            this.queue.push({
                creator, configOwner, configName,
                completionHandler: resolve,
                weights,
                charms,
                cp,
                upgrades,
                creationTime: Date.now(),
            });
        });
    }

    public getCurrTask() {
        return this.currTask;
    }

    public getEntries() {
        return this.queue.entries();
    }
}
