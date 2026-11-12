import type {ConfigSettings, UserWeightConfig} from "./data";

// Reads and writes whole configs as text, in the same format as mtce's .conf files:
//
//     charm_power = 15        # optional settings come first
//     max_upgrades = 2
//     upgrade_penalty = 1
//     [weights]
//     firework_blast_cooldown = 10
//
// The bot's older format (bare `effect = weight` lines, no [weights] header) is accepted too. Comments start with #.

export const WEIGHT_LIMIT = 2000000000n;

const SETTINGS: Record<string, {key: keyof ConfigSettings; min: number; max: number}> = {
    charm_power: {key: "cp", min: 1, max: 15, },
    max_upgrades: {key: "maxUpgrades", min: 0, max: 7, },
    upgrade_penalty: {key: "upgradePenalty", min: 0, max: 1000000, },
};

export type ParseResult = {ok: true; config: UserWeightConfig} | {ok: false; errors: string[]};

export function parseConfigText(text: string, isKnownEffect: (effect: string) => boolean): ParseResult {
    const errors: string[] = [];
    const weights: Record<string, string> = {};
    const settings: ConfigSettings = {};
    const seen = new Map<string, number>();

    text.split(/\r\n|\r|\n/).forEach((raw, idx) => {
        const lineNo = idx + 1;
        const hash = raw.indexOf("#");
        const line = (hash === -1 ? raw : raw.substring(0, hash)).trim();

        // blank lines, and Discord code fences (``` or ```ini) left over from copying a config out of a message
        if (line.length === 0 || line.startsWith("```")) {
            return;
        }

        const section = line.match(/^\[(.*)\]$/);
        if (section) {
            if (section[1].trim() !== "weights") {
                errors.push(`line ${lineNo}: unknown section \`[${section[1]}]\` (only \`[weights]\` exists)`);
            }
            return;
        }

        const eq = line.indexOf("=");
        if (eq === -1) {
            errors.push(`line ${lineNo}: expected \`name = value\`, got \`${line}\``);
            return;
        }

        const key = line.substring(0, eq).trim().toLowerCase();
        const value = line.substring(eq + 1).trim();

        if (!/^-?\d+$/.test(value)) {
            errors.push(`line ${lineNo}: \`${key}\` needs a whole number, got \`${value}\``);
            return;
        }

        const previous = seen.get(key);
        if (previous !== undefined) {
            errors.push(`line ${lineNo}: \`${key}\` is already set on line ${previous}`);
            return;
        }
        seen.set(key, lineNo);

        const setting = SETTINGS[key];
        if (setting !== undefined) {
            const n = Number(value);
            if (n < setting.min || n > setting.max) {
                errors.push(`line ${lineNo}: \`${key}\` must be between ${setting.min} and ${setting.max}, got ${value}`);
                return;
            }
            settings[setting.key] = n;
            return;
        }

        if (!isKnownEffect(key)) {
            errors.push(`line ${lineNo}: unknown effect \`${key}\` (try \`/findeffect\`)`);
            return;
        }

        const weight = BigInt(value);
        if (weight > WEIGHT_LIMIT || weight < -WEIGHT_LIMIT) {
            errors.push(`line ${lineNo}: weight for \`${key}\` must be between -${WEIGHT_LIMIT} and ${WEIGHT_LIMIT}`);
            return;
        }

        // weights of 0 mean "ignore this effect"; dropping them keeps the config (and mtce) lean
        if (weight !== 0n) {
            weights[key] = weight.toString();
        }
    });

    if (errors.length > 0) {
        return {ok: false, errors, };
    }

    return {ok: true, config: Object.keys(settings).length > 0 ? {weights, settings, } : {weights, }, };
}

// The inverse of parseConfigText: what `/config get` shows, so it can be copied, edited and pasted back.
export function formatConfigText(config: UserWeightConfig, isKnownEffect?: (effect: string) => boolean): string {
    const lines: string[] = [];

    for (const [name, {key, }] of Object.entries(SETTINGS)) {
        const value = config.settings?.[key];
        if (value !== undefined) {
            lines.push(`${name} = ${value}`);
        }
    }

    lines.push("[weights]");
    for (const [effect, weight] of Object.entries(config.weights)) {
        const known = isKnownEffect === undefined || isKnownEffect(effect);
        lines.push(known ? `${effect} = ${weight}` : `${effect} = ${weight}  # unknown effect (removed in a Monumenta update?)`);
    }

    return lines.join("\n");
}
