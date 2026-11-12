import {readFile, writeFile} from "node:fs/promises";
import {logger} from "./log";

// The charm effect list from the Monumenta API, with a local fallback: every successful fetch is saved to EFFECTS_CACHE_PATH,
// and if the API is down at startup the bot uses that copy instead of crashing. The list is public data (effect names
// only); the file is git-ignored because it changes as Monumenta updates.

const EFFECTS_URL = "https://api.playmonumenta.com/zenith_charm_effects";
export const EFFECTS_CACHE_PATH = "effects_cache.json";
const FETCH_TIMEOUT_MS = 15000;

interface EffectsCache {
    fetchedAt: string;
    effectNames: string[];
}

function validNames(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every(x => typeof x === "string" && x.length > 0);
}

async function fetchEffectNames(): Promise<string[]> {
    const res = await fetch(EFFECTS_URL, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), });
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
    }

    const json: unknown = await res.json();
    const names = Array.isArray(json) ? json.map(x => (x as {effectName?: unknown})?.effectName) : undefined;
    if (!validNames(names)) {
        throw new Error("unexpected response format");
    }
    return names;
}

async function readCache(path: string): Promise<EffectsCache> {
    const cache = JSON.parse(await readFile(path, "utf8")) as Partial<EffectsCache>;
    if (!validNames(cache.effectNames) || typeof cache.fetchedAt !== "string") {
        throw new Error(`${path} is malformed`);
    }
    return cache as EffectsCache;
}

export async function loadEffectNames(cachePath = EFFECTS_CACHE_PATH): Promise<string[]> {
    try {
        const effectNames = await fetchEffectNames();
        try {
            await writeFile(cachePath, JSON.stringify({fetchedAt: new Date().toISOString(), effectNames, } satisfies EffectsCache));
        } catch (e) {
            logger.error("could not update the effect cache", e);
        }
        return effectNames;
    } catch (fetchError) {
        let cache: EffectsCache;
        try {
            cache = await readCache(cachePath);
        } catch (cacheError) {
            throw new Error(`Failed to fetch charm effects (${String(fetchError)}) and no usable cache at ${cachePath} ` +
                `(${String(cacheError)}). The bot needs to reach ${EFFECTS_URL} once to create the cache.`);
        }
        logger.info(`[effects] WARNING: could not fetch charm effects (${String(fetchError)}); ` +
            `using ${cache.effectNames.length} cached effects from ${cache.fetchedAt}. Restart once the API is back to refresh.`);
        return cache.effectNames;
    }
}
