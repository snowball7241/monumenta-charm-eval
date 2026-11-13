import type {ChosenCharm} from "./format";

// Charm data files: one charm per line, `rarity;name;charm power;effect:effect:...;value:value:...`, plus a sixth
// `value:value:...` part for charms that can be upgraded (their "(u)" values). Shared by the bot and the web front end.

export type CharmParseResult = {ok: true; charms: string[]} | {ok: false; badLines: number[]};

export function parseCharmText(text: string, isKnownEffect: (effect: string) => boolean): CharmParseResult {
    const charmLines = text.split(/\r\n|\r|\n/)
        .map((str, idx) => [str.trim(), idx + 1] as [string, number])
        .filter(([str]) => str.length !== 0);

    const badLines = charmLines.filter(([str]) => !isValidCharmLine(str, isKnownEffect)).map(([, lineNo]) => lineNo);
    if (badLines.length > 0) {
        return {ok: false, badLines, };
    }
    return {ok: true, charms: charmLines.map(([str]) => str), };
}

function isValidCharmLine(line: string, isKnownEffect: (effect: string) => boolean): boolean {
    const parts = line.split(";");
    if (parts.length !== 5 && parts.length !== 6) {
        return false;
    }

    const [rarity, , cp, effectNames, effectValues] = parts;
    const effectNameSplit = effectNames.split(":");
    if (effectNameSplit.some(x => !isKnownEffect(x))) {
        return false;
    }

    const validValues = (content: string): boolean => {
        const data = content.split(":");
        return data.length === effectNameSplit.length && data.every(x => !Number.isNaN(parseFloat(x)));
    };

    return parseInt(rarity) >= 0 && parseInt(rarity) < 5 &&
        parseInt(cp) > 0 &&
        validValues(effectValues) &&
        (parts.length === 5 || validValues(parts[5]));
}

// mtce numbers charms in file order, with an upgradable charm followed by its "(u)" copy (one rarity higher)
export function charmEntries(charms: string[]): ChosenCharm[] {
    return charms.flatMap(x => {
        const parts = x.split(";");
        const name = parts[1];
        const rarity = parseInt(parts[0]);
        const charmPower = parseInt(parts[2]);
        const base = {name, charmPower, rarity, upgraded: false, };
        return parts.length === 6 ? [base, {name: `${name} (u)`, charmPower, rarity: rarity + 1, upgraded: true, }] : [base];
    });
}
