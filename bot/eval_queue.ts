import {writeFile} from "node:fs/promises";
import {BlockingQueue} from "./blocking_queue";
import {file as createTmpFile} from "tmp-promise";
import {logger} from "./log";
import {getConfig} from "./config";
import {performance} from "node:perf_hooks";
import {appendEvalRecord, buildMtceArgs, mtceIdentity} from "./eval_log";
import {fmtElapsed, parseBotOutput, runMtce} from "./mtce_process";

export {fmtElapsed};

const MTCE_BINARY = "./mtce";
const ALGO = "bnb";
const PROGRESS_INTERVAL_MS = 60 * 1000;

// Shared by the console status lines and /queue so both say the same thing. `user` renders a Discord id
// (raw id on the console, a mention in Discord).
export function describeTask(task: CharmEvalTask, user: (id: string) => string = id => id): string {
    const extras = [
        `${task.charms.length} charms`, `cp ${task.cp}`,
        ...(task.upgrades.maxUpgrades !== undefined ? [`max ${task.upgrades.maxUpgrades} upgrades`] : []),
        ...(task.upgrades.upgradePenalty ? [`upgrade penalty ${task.upgrades.upgradePenalty}`] : [])
    ];
    return `${user(task.configOwner)}:${task.configName} for ${user(task.creator)} (${extras.join(", ")})`;
}

export function runningStatus(task: RunningTask, waiting: number, user?: (id: string) => string): string {
    return `still running after ${fmtElapsed(Date.now() - task.startTime)}: ${describeTask(task, user)}, ${waiting} waiting`;
}

export type EvalResult = {
    success: true;
    weight: bigint;
    charms: number[];
    // false = mtce hit the time limit: this is the best set it found, which may not be optimal
    complete: boolean;
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
}

// mtce stops itself at the configured timeout and returns its best set; it is only killed if it overruns that by this much
const KILL_GRACE_SEC = 30;

async function doTask(task: CharmEvalTask, filePath: string): Promise<EvalResult> {
    await writeFile(filePath, task.charms.join("\n"));

    const args = buildMtceArgs({weights: task.weights, cp: task.cp, ...task.upgrades, }, filePath, ALGO, getConfig().threads, {
        timeLimitSec: getConfig().timeout,
    });
    logger.audit("eval_queue.spawn", {args, });
    const spawnResult = await runMtce(MTCE_BINARY, args, (getConfig().timeout + KILL_GRACE_SEC) * 1000).done;

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
                // mtce normally stops itself at the timeout with a result; a kill means it overran even the grace period
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

    const output = parseBotOutput(spawnResult.stdout.toString("utf8"));
    if (output === undefined) {
        return {
            success: false,
            error: "Internal error: illegal output from charm evaluator",
        };
    }

    logger.audit("eval_queue.done", {weight: output.weight, charms: output.charms, complete: spawnResult.complete, ...auditLogCommon, });
    return {success: true, complete: spawnResult.complete, ...output, };
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
            // status line once per minute, so a long run is visibly still alive
            const progress = setInterval(() => {
                logger.info(`[eval] ${runningStatus(running, this.queue.entries().length)}`);
            }, PROGRESS_INTERVAL_MS);

            try {
                const startedAt = new Date();
                const result = await doTask(task, charmsFile.path);
                clearInterval(progress);
                const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
                const outcome = !result.success ? `failed (${result.error})` : result.complete ? "finished" : "stopped at the time limit (best set so far)";
                logger.info(`[eval] ${outcome} after ${elapsed()}: ${describe}`);

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
                        {ok: true, weight: result.weight.toString(), charms: result.charms, ...(result.complete ? {} : {complete: false, }), } :
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
