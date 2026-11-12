// Discord renders ANSI colors inside ```ansi code blocks, but only the 8 basic foreground colors (30-37) plus bold. mtce prints
// 24-bit colors, so they are mapped onto that palette: mtce's own colors explicitly (so they look intentional), anything else to
// the nearest palette entry. Mobile Discord shows these blocks as plain, uncolored text.

const ESC = "\u001b";

// approximate RGB of Discord's ANSI palette (dark theme), used for nearest-color matching
const PALETTE: [code: number, rgb: [number, number, number]][] = [
    [30, [79, 84, 92]], // gray
    [31, [220, 50, 47]], // red
    [32, [133, 153, 0]], // green
    [33, [181, 137, 0]], // yellow
    [34, [38, 139, 210]], // blue
    [35, [211, 54, 130]], // pink
    [36, [42, 161, 152]], // cyan
    [37, [255, 255, 255]] // white
];

// mtce's colors (include/cli/color.h, src/cli/main.cpp, COLOR_BY_RARITY in src/cli/cli.cpp)
const KNOWN: Record<number, number> = {
    0x4ac2e5: 36, // normal stat -> cyan
    0xe49b20: 33, // capped stat / rarity 4 -> yellow
    0xd02e28: 31, // negative stat -> red
    0x808080: 30, // gray: weighted effect with no value
    0x9f929c: 30, // rarity 0 -> gray
    0x70bc6d: 32, // rarity 1 -> green
    0x705eca: 34, // rarity 2 -> blue
    0xcd5eca: 35, // rarity 3 -> pink
    0xe59e67: 33, // "yellow" macro
    0x6bb05d: 32, // "green" macro
};

export function discordColorCode(rgb: number): number {
    const known = KNOWN[rgb];
    if (known !== undefined) {
        return known;
    }

    const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
    let best = 37, bestDist = Infinity;
    for (const [code, [pr, pg, pb]] of PALETTE) {
        const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (dist < bestDist) {
            best = code;
            bestDist = dist;
        }
    }
    return best;
}

// charm name colors by rarity, as mtce uses for the terminal (an upgraded "(u)" copy is one rarity higher)
const RARITY_RGB = [0x9f929c, 0x70bc6d, 0x705eca, 0xcd5eca, 0xe49b20];

export function colorByRarity(text: string, rarity: number): string {
    const rgb = RARITY_RGB[Math.min(Math.max(rarity, 0), RARITY_RGB.length - 1)];
    return `${ESC}[${discordColorCode(rgb)}m${text}${ESC}[0m`;
}

// Rewrites mtce's ANSI output (24-bit colors, bold, resets) into codes Discord's ```ansi blocks understand. Every line ends
// with a reset so a style never bleeds onto the next line.
export function toDiscordAnsi(text: string): string {
    return text.split("\n").map(line => {
        let bold = false;
        let fg: number | undefined;
        let out = "";
        let last = 0;

        const emit = () => {
            const codes = ["0"];
            if (bold) codes.push("1");
            if (fg !== undefined) codes.push(String(fg));
            out += `${ESC}[${codes.join(";")}m`;
        };

        // eslint-disable-next-line no-control-regex -- matching ANSI escape sequences is the point
        for (const match of line.matchAll(/\u001b\[([0-9;]*)m/g)) {
            const index = match.index ?? 0;
            out += line.slice(last, index);
            last = index + match[0].length;

            const params = match[1] === "" ? [0] : match[1].split(";").map(Number);
            for (let i = 0; i < params.length; i++) {
                const p = params[i];
                if (p === 0) {
                    bold = false;
                    fg = undefined;
                } else if (p === 1) {
                    bold = true;
                } else if (p === 22) {
                    bold = false;
                } else if (p >= 30 && p <= 37) {
                    fg = p;
                } else if (p === 39) {
                    fg = undefined;
                } else if (p === 38 && params[i + 1] === 2) {
                    const [r, g, b] = params.slice(i + 2, i + 5);
                    fg = discordColorCode(((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff));
                    i += 4;
                } else if (p === 38 && params[i + 1] === 5) {
                    i += 2; // 256-color: not produced by mtce; ignore
                }
            }
            emit();
        }

        out += line.slice(last);
        return out.endsWith(`${ESC}[0m`) || !out.includes(ESC) ? out : out + `${ESC}[0m`;
    }).join("\n");
}

// Every code toDiscordAnsi emits states the complete style (it starts from "0"), so in a run of consecutive codes only the last
// one matters. Dropping the rest (mtce emits e.g. "[1m[38;2;...m" and "[0m[0m") saves characters against Discord's 2000 limit.
export function compactAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex -- matching ANSI escape sequences is the point
    return text.replace(/(?:\u001b\[[0-9;]*m)+(\u001b\[[0-9;]*m)/g, "$1");
}
