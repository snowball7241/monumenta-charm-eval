import {spawn} from "node:child_process";
import {stripVTControlCharacters} from "node:util";

// Running mtce in --bot-mode and reading its output. Shared by the bot's queue and the web front end.

export function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface SpawnResult {
    success: boolean;
    result: string | number | Error; // exit code, signal name, or spawn error
    stdout: Buffer;
    stderr: Buffer;     // everything but the incomplete line
    complete: boolean;  // false if mtce stopped at --bnb-time-limit
}

const INCOMPLETE_LINE = "incomplete";

export interface MtceRun {
    done: Promise<SpawnResult>;
    kill: () => void;
}

// `timeoutMs` is a hard kill (SIGTERM); with --bnb-time-limit mtce normally stops itself well before it.
export function runMtce(binary: string, args: string[], timeoutMs: number | undefined): MtceRun {
    const proc = spawn(binary, args, timeoutMs !== undefined ? {timeout: timeoutMs, } : {});

    const done = new Promise<SpawnResult>((resolve) => {
        let stdout = Buffer.of();
        let stderr = Buffer.of();
        let stderrPartial = ""; // an unfinished last line, until the rest arrives
        let complete = true;

        const handleStderrLine = (line: string): boolean => { // true = keep it as error output
            if (line === INCOMPLETE_LINE) {
                complete = false;
                return false;
            }
            return true;
        };

        proc.addListener("close", (code, signal) => {
            if (code !== null) {
                resolve({success: code === 0, result: code, stdout, stderr, complete, });
            } else if (signal !== null) {
                resolve({success: false, result: signal, stdout, stderr, complete, });
            }
        });

        proc.addListener("error", error => {
            resolve({success: false, result: error, stdout, stderr, complete, });
        });

        proc.stdout.on("data", (entry: Buffer) => stdout = Buffer.concat([stdout, entry]));
        proc.stderr.on("data", (entry: Buffer) => {
            const lines = (stderrPartial + entry.toString("utf8")).split("\n");
            stderrPartial = lines.pop() ?? "";
            const kept = lines.filter(handleStderrLine);
            if (kept.length > 0) {
                stderr = Buffer.concat([stderr, Buffer.from(kept.join("\n") + "\n")]);
            }
        });
        proc.stderr.on("end", () => {
            if (stderrPartial.length > 0 && handleStderrLine(stderrPartial)) {
                stderr = Buffer.concat([stderr, Buffer.from(stderrPartial)]);
            }
        });
    });

    return {done, kill: () => proc.kill("SIGTERM"), };
}

export interface MtceOutput {
    weight: bigint;
    charms: number[];   // mtce's charm numbers (see charmEntries)
    stats: string;      // plain text
    statsAnsi: string;  // mtce's original colored output
}

// --bot-mode stdout: the weight, one charm number per line, a blank line, then the set's stats. undefined if malformed.
export function parseBotOutput(stdout: string): MtceOutput | undefined {
    const parts = stdout.trim().split("\n\n");
    if (parts.length !== 2) {
        return undefined;
    }

    const rawLines = parts[0].split("\n");
    try {
        return {
            weight: BigInt(rawLines[0]),
            charms: rawLines.slice(1).map(x => parseInt(x)),
            stats: stripVTControlCharacters(parts[1]),
            statsAnsi: parts[1],
        };
    } catch {
        return undefined;
    }
}
