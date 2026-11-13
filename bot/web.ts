// Local web front end for mtce, an alternative to hosting the Discord bot: paste or load a config and a charm file, evaluate,
// and see the result with mtce's colors.
//
//   npx tsx web.ts [--port 8080] [--threads n] [--mtce ./mtce]
//
// then open http://localhost:8080. It listens on this computer only (127.0.0.1) and needs no Discord token or bot config.
// Config and charm text use the same formats as the bot (see config_text.ts and charm_data.ts).

import {createServer, IncomingMessage, ServerResponse} from "node:http";
import {readFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {availableParallelism} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {file as createTmpFile} from "tmp-promise";
import {loadEffectNames} from "./effects";
import {parseConfigText} from "./config_text";
import {charmEntries, parseCharmText} from "./charm_data";
import {buildMtceArgs} from "./eval_log";
import {MtceRun, parseBotOutput, runMtce} from "./mtce_process";
import type {ChosenCharm} from "./format";

const PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "web", "index.html");
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_TIME_LIMIT_SEC = 24 * 60 * 60;

function parseArgs(argv: string[]) {
    const opts = {port: 8080, threads: availableParallelism(), mtce: "./mtce", };
    for (let i = 0; i < argv.length; i++) {
        const value = () => {
            const v = argv[++i];
            if (v === undefined) {
                throw new Error(`${argv[i - 1]} needs a value`);
            }
            return v;
        };
        switch (argv[i]) {
        case "--port": opts.port = Number(value()); break;
        case "--threads": opts.threads = Number(value()); break;
        case "--mtce": opts.mtce = value(); break;
        case "--help": case "-h":
            console.log("usage: npx tsx web.ts [--port 8080] [--threads n] [--mtce ./mtce]");
            process.exit(0);
            break;
        default:
            throw new Error(`unknown option ${argv[i]} (try --help)`);
        }
    }
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
        throw new Error("--port must be 1-65535");
    }
    if (!Number.isInteger(opts.threads) || opts.threads < 1) {
        throw new Error("--threads must be a positive whole number");
    }
    return opts;
}

const opts = parseArgs(process.argv.slice(2));
const knownEffects = new Set((await loadEffectNames()).map(name => name.toLowerCase().replace(/ /g, "_")));
const isKnownEffect = (effect: string) => knownEffects.has(effect);

interface JobResult {
    weight: string;
    complete: boolean;
    charms: ChosenCharm[];
    cpUsed: number;
    maxCp: number;
    upgradesUsed: number;
    maxUpgrades?: number;
    statsAnsi: string;
}

interface Job {
    id: number;
    startTime: number;
    endTime?: number;
    state: "running" | "done" | "error" | "cancelled";
    timeLimitSec?: number;
    result?: JobResult;
    error?: string;
    run?: MtceRun;
}

let job: Job | undefined;
let nextJobId = 1;

// one evaluation at a time: mtce already uses every core
async function startJob(configText: string, charmText: string, timeLimitSec: number | undefined): Promise<{errors: string[]} | {id: number}> {
    const config = parseConfigText(configText, isKnownEffect, "(check the spelling; names are as in the charm file)");
    const charms = parseCharmText(charmText, isKnownEffect);
    const errors = [
        ...(config.ok ? [] : config.errors.map(e => `Config ${e}`)),
        ...(config.ok && Object.keys(config.config.weights).length === 0 ? ["Config has no weights: add effects under [weights]."] : []),
        ...(charms.ok ? [] : [`Charm data: bad or unknown-effect charms on lines ${charms.badLines.join(", ")}.`]),
        ...(charms.ok && charms.charms.length === 0 ? ["Charm data is empty: paste or load your charm file."] : [])
    ];
    if (!config.ok || !charms.ok || errors.length > 0) {
        return {errors, };
    }
    if (job?.state === "running") {
        return {errors: ["An evaluation is already running: wait for it or cancel it."], };
    }

    const cp = config.config.settings?.cp ?? 15;
    const maxUpgrades = config.config.settings?.maxUpgrades;
    const upgradePenalty = config.config.settings?.upgradePenalty;

    const current: Job = {id: nextJobId++, startTime: Date.now(), state: "running", timeLimitSec, };
    job = current;

    const charmsFile = await createTmpFile();
    await writeFile(charmsFile.path, charms.charms.join("\n"));
    const runOptions = {weights: config.config.weights, cp, maxUpgrades, upgradePenalty, };
    const args = buildMtceArgs(runOptions, charmsFile.path, "bnb", opts.threads, {timeLimitSec, });
    current.run = runMtce(opts.mtce, args, undefined);
    console.log(`[web] evaluating ${charms.charms.length} charms, ${Object.keys(config.config.weights).length} weights, cp ${cp}` +
        (timeLimitSec !== undefined ? `, time limit ${timeLimitSec}s` : ""));

    current.run.done.then(spawn => {
        current.endTime = Date.now();
        current.run = undefined;
        charmsFile.cleanup();
        if (current.state === "cancelled") {
            return;
        }

        const output = spawn.success ? parseBotOutput(spawn.stdout.toString("utf8")) : undefined;
        if (output === undefined) {
            current.state = "error";
            const detail = spawn.stderr.toString("utf8").trim() || spawn.stdout.toString("utf8").trim();
            current.error = spawn.result instanceof Error ? `Could not run mtce (${opts.mtce}): ${spawn.result.message}` :
                detail.length > 0 ? `mtce: ${detail}` : `mtce failed (${spawn.result}).`;
            console.log(`[web] failed: ${current.error}`);
            return;
        }

        const entries = charmEntries(charms.charms);
        const chosen = output.charms.map(i => entries[i]);
        current.state = "done";
        current.result = {
            weight: output.weight.toString(),
            complete: spawn.complete,
            charms: chosen,
            cpUsed: chosen.reduce((sum, c) => sum + c.charmPower, 0),
            maxCp: cp,
            upgradesUsed: chosen.filter(c => c.upgraded).length,
            maxUpgrades,
            statsAnsi: output.statsAnsi,
        };
        console.log(`[web] ${spawn.complete ? "done" : "stopped at the time limit"} after ${((current.endTime - current.startTime) / 1000).toFixed(1)}s`);
    });

    return {id: current.id, };
}

function jobStatus() {
    if (job === undefined) {
        return {job: null, };
    }
    const {id, startTime, endTime, state, timeLimitSec, result, error, } = job;
    return {
        job: {
            id, startTime, endTime, state, timeLimitSec, result, error,
            elapsedMs: (job.endTime ?? Date.now()) - job.startTime,
        },
    };
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {"Content-Type": "application/json", "Cache-Control": "no-store", });
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// Only this computer's browser may use the server: the Host check stops DNS-rebinding pages, and requiring a same-origin JSON
// POST stops other websites from starting evaluations (a cross-site JSON request needs a CORS preflight, which is never granted).
function allowed(req: IncomingMessage): boolean {
    const hosts = [`localhost:${opts.port}`, `127.0.0.1:${opts.port}`];
    if (!hosts.includes(req.headers.host ?? "")) {
        return false;
    }
    if (req.method === "POST") {
        const origin = req.headers.origin;
        if (origin !== undefined && !hosts.some(h => origin === `http://${h}`)) {
            return false;
        }
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
            return false;
        }
    }
    return true;
}

const server = createServer(async (req, res) => {
    try {
        if (!allowed(req)) {
            send(res, 403, {errors: ["forbidden"], });
            return;
        }

        const path = new URL(req.url ?? "/", "http://localhost").pathname;

        if (req.method === "GET" && path === "/") {
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
            });
            res.end(readFileSync(PAGE_PATH)); // read each time, so page edits show on reload
        } else if (req.method === "GET" && path === "/api/status") {
            send(res, 200, jobStatus());
        } else if (req.method === "POST" && path === "/api/evaluate") {
            const body = JSON.parse(await readBody(req)) as {config?: unknown; charms?: unknown; timeLimitSec?: unknown};
            if (typeof body.config !== "string" || typeof body.charms !== "string") {
                send(res, 400, {errors: ["config and charms must be text"], });
                return;
            }
            const limit = body.timeLimitSec;
            if (limit !== undefined && limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > MAX_TIME_LIMIT_SEC)) {
                send(res, 400, {errors: [`Time limit must be a whole number of seconds from 0 to ${MAX_TIME_LIMIT_SEC}.`], });
                return;
            }
            const started = await startJob(body.config, body.charms, typeof limit === "number" && limit > 0 ? limit : undefined);
            send(res, "errors" in started ? 400 : 200, started);
        } else if (req.method === "POST" && path === "/api/cancel") {
            if (job?.state === "running") {
                job.state = "cancelled";
                job.run?.kill();
            }
            send(res, 200, jobStatus());
        } else {
            send(res, 404, {errors: ["not found"], });
        }
    } catch (e) {
        send(res, 400, {errors: [e instanceof Error ? e.message : String(e)], });
    }
});

server.on("error", e => {
    console.error(`could not start the web server: ${e.message}`);
    process.exit(1);
});

server.listen(opts.port, "127.0.0.1", () => {
    console.log(`mtce web front end: http://localhost:${opts.port}  (${opts.threads} threads, mtce at ${opts.mtce}; Ctrl+C to stop)`);
});
