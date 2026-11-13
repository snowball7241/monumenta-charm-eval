import {colorByRarity, compactAnsi, toDiscordAnsi} from "./ansi";

export const DISCORD_MESSAGE_LIMIT = 2000;

export interface ChosenCharm {
    name: string;        // including " (u)" for an upgraded copy
    charmPower: number;
    rarity: number;      // as displayed: an upgraded copy is one rarity higher than its base
    upgraded: boolean;
}

export interface EvalMessageInput {
    weight: bigint;
    charms: ChosenCharm[];
    maxCp: number;
    maxUpgrades?: number;
    stats: string;      // plain
    statsAnsi: string;  // mtce's colored output
    note?: string;      // shown above the result, e.g. that the search stopped at the time limit
}

// The evaluate reply, mirroring the terminal output. Colored (```ansi blocks) when it fits in one Discord message; otherwise
// plain text, and if even that is too long, the stats list is cut short with a note rather than failing to send.
export function formatEvalMessage(input: EvalMessageInput): string {
    const cpUsed = input.charms.reduce((sum, c) => sum + c.charmPower, 0);
    const upgradesUsed = input.charms.filter(c => c.upgraded).length;

    const summary =
        `Charm power used: ${cpUsed}/${input.maxCp}\n` +
        `Upgrades used: ${upgradesUsed}${input.maxUpgrades !== undefined ? `/${input.maxUpgrades}` : ""}\n`;

    const build = (colored: boolean, statsLines: string[], omitted: number) =>
        (input.note !== undefined ? `${input.note}\n` : "") +
        `Weight: ${input.weight}\n` +
        (colored ? "```ansi\n" : "```\n") +
        input.charms.map(c => {
            const line = `${c.name} (${c.charmPower})`;
            return colored ? colorByRarity(line, c.rarity) : line;
        }).join("\n") + "\n" +
        "```\n" +
        summary +
        "Stats:\n" +
        (colored ? "```ansi\n" : "```\n") +
        statsLines.join("\n") + "\n" +
        (omitted > 0 ? `... ${omitted} more\n` : "") +
        "```";

    const colored = build(true, compactAnsi(toDiscordAnsi(input.statsAnsi.trim())).split("\n"), 0);
    if (colored.length <= DISCORD_MESSAGE_LIMIT) {
        return colored;
    }

    const plainLines = input.stats.trim().split("\n");
    for (let keep = plainLines.length; keep >= 0; keep--) {
        const plain = build(false, plainLines.slice(0, keep), plainLines.length - keep);
        if (plain.length <= DISCORD_MESSAGE_LIMIT) {
            return plain;
        }
    }

    return build(false, [], plainLines.length).slice(0, DISCORD_MESSAGE_LIMIT);
}
