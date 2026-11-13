import {
    ActionRowBuilder,
    ChatInputCommandInteraction,
    ModalBuilder,
    ModalSubmitInteraction,
    TextInputBuilder,
    TextInputStyle,
    User
} from "discord.js";
import {UserData, UserEvalJob, UserWeightConfig} from "./data";
import {describeTask, EvalJobRunner, fmtElapsed, runningStatus} from "./eval_queue";
import {ChosenCharm, formatEvalMessage} from "./format";
import {formatConfigText, parseConfigText} from "./config_text";
import {getConfig} from "./config";

import {loadEffectNames} from "./effects";

const effectNames = await loadEffectNames();

export type CommandOption = {
    type: string;
    description: string;
    required?: boolean;

} & ({
    type: "string" | "user" | "file";
} | {
    type: "integer";
    min?: number;
    max?: number;
})

export interface SubCommandNode {
    description: string;
    children: Record<string, ExecuteNode>;
}

export interface ExecuteNode {
    description: string;
    options: Record<string, CommandOption>;
    executor: (interaction: ChatInputCommandInteraction, userData: UserData, queue: EvalJobRunner) => Promise<void>;
}

export function isSubCommandNode(node: SubCommandNode | ExecuteNode): node is SubCommandNode {
    return "children" in node;
}

const NAME_TO_ID = new Map(effectNames.map((name, i) => [name.toLowerCase().replace(/ /g, "_"), i]));

export async function sendReply(interaction: ChatInputCommandInteraction, msg: string) {
    if (interaction.replied) {
        await interaction.followUp({
            content: msg,
            allowedMentions: {
                parse: [],
            },
        });
    } else if (interaction.deferred) {
        await interaction.editReply({
            content: msg,
            allowedMentions: {
                parse: [],
            },
        });

    } else {
        await interaction.reply({
            content: msg,
            allowedMentions: {
                parse: [],
            },
        });
    }
}

// /config import: the modal's custom id carries the target as `config_import:<owner id>:<name>` (custom ids max 100 chars)
export const CONFIG_IMPORT_PREFIX = "config_import:";
const CONFIG_IMPORT_FIELD = "config_text";
const CONFIG_NAME_MAX = 60;

function formatParseErrors(errors: string[]): string {
    const shown = errors.slice(0, 15);
    return `Config not saved, please fix:\n${shown.map(e => `- ${e}`).join("\n")}` +
        (errors.length > shown.length ? `\n- ... and ${errors.length - shown.length} more` : "");
}

export async function handleConfigImportSubmit(interaction: ModalSubmitInteraction, userData: UserData) {
    const target = interaction.customId.substring(CONFIG_IMPORT_PREFIX.length);
    const sep = target.indexOf(":");
    const ownerId = target.substring(0, sep);
    const name = target.substring(sep + 1);

    const reply = (content: string) => interaction.reply({content, allowedMentions: {parse: [], }, });

    // the custom id comes from the client, so check everything again
    if (sep === -1 || !/^\d+$/.test(ownerId) || !/^\w+$/.test(name) || name.length > CONFIG_NAME_MAX) {
        await reply("Invalid config import.");
        return;
    }

    if (interaction.user.id !== ownerId && !userData.isAdmin(interaction.user.id)) {
        await reply("You do not have permission to create a config to this user!");
        return;
    }

    const parsed = parseConfigText(interaction.fields.getTextInputValue(CONFIG_IMPORT_FIELD), x => NAME_TO_ID.has(x));

    if (!parsed.ok) {
        await reply(formatParseErrors(parsed.errors));
        return;
    }

    const replaced = userData.fetchConfig(ownerId, name) !== undefined;
    userData.createConfig(ownerId, name, parsed.config, true);

    const weights = Object.keys(parsed.config.weights).length;
    await reply(
        `${replaced ? "Replaced" : "Created"} config <@${ownerId}>:${name} (${weights} weight${weights === 1 ? "" : "s"}):\n` +
        "```ini\n" + formatConfigText(parsed.config) + "\n```"
    );
}

async function validateConfigName(interaction: ChatInputCommandInteraction, name: string): Promise<boolean> {
    if (!/^\w+$/.test(name)) {
        await sendReply(interaction, `Name ${name} is invalid, must be non-empty and consist only of letters or underscores.`);
        return false;
    }

    return true;

}

async function validateAndNormalizeConfig(interaction: ChatInputCommandInteraction, config: UserWeightConfig): Promise<UserWeightConfig> {
    const unknowns = Object.entries(config.weights).filter(([key]) => !NAME_TO_ID.has(key));

    if (unknowns.length === 0) {
        return config;
    }

    await sendReply(
        interaction,
        `Unknown weights [${unknowns.map(x => `\`${x}\``).join(", ")}] found in config, deleting (most likely because they were removed in a Monumenta update)!`
    );

    return {
        ...config,
        weights: Object.fromEntries(Object.entries(config.weights).filter(([key]) => NAME_TO_ID.has(key))),
    };
}

function validateWeight(weight: string) {
    try {
        const value = BigInt(weight);

        if (value > 2000000000n || value < -2000000000n) {
            return false;
        }
    } catch {
        return false;
    }

    return true;
}

async function tryFetchConfig(interaction: ChatInputCommandInteraction, userData: UserData, owner: string | User, name: string): Promise<UserWeightConfig | undefined> {
    const id = typeof owner === "string" ? owner : owner.id;
    const config = userData.fetchConfig(id, name);

    if (config === undefined) {
        await sendReply(interaction, `Config <@${id}>:${name} not found.`);
    }

    return config;
}

function splitByNewline(value: string): string[] {
    return value.split(/\r\n|\r|\n/);
}

async function doEvaluateCharms(interaction: ChatInputCommandInteraction, userData: UserData, queue: EvalJobRunner, task: UserEvalJob) {
    const {owner, name, charmDataUrl: url, } = task;

    const config = await tryFetchConfig(interaction, userData, owner, name);

    if (config === undefined) {
        return;
    }

    // an explicit /evaluate option wins, then the config's own setting, then the default
    const cp = task.cp ?? config.settings?.cp ?? 15;
    const maxUpgrades = task.maxUpgrades ?? config.settings?.maxUpgrades;
    const upgradePenalty = task.upgradePenalty ?? config.settings?.upgradePenalty;

    await interaction.deferReply();

    // fetch charm data 
    const fetchResult = await fetch(url);

    if (cp > 15 || cp < 1) {
        await sendReply(interaction, `Bad value for charm power ${cp}`);
        return;
    }

    if (maxUpgrades !== undefined && (maxUpgrades < 0 || maxUpgrades > 7)) {
        await sendReply(interaction, `Bad value for max upgrades ${maxUpgrades}`);
        return;
    }

    if (upgradePenalty !== undefined && (upgradePenalty < 0 || upgradePenalty > 1000000)) {
        await sendReply(interaction, `Bad value for upgrade penalty ${upgradePenalty}`);
        return;
    }

    if (!fetchResult.ok) {
        await sendReply(interaction, `Failed to fetch charm data: ${fetchResult.statusText}`);
        return;
    }

    const charmText = await fetchResult.text();

    const charmLines = splitByNewline(charmText)
        .map((str, idx) => [str.trim(), idx + 1] as [string, number])
        .filter(([str]) => str.length !== 0);

    const badLines = charmLines.filter(([str]) => {
        const parts = str.split(";");
        if (parts.length !== 5 && parts.length !== 6) {
            return true;
        }

        const [rarity, , cp, effectNames, effectValues] = parts;

        const effectNameSplit = effectNames.split(":");

        if (effectNameSplit.filter(x => !NAME_TO_ID.has(x)).length > 0) {
            return true;
        }

        const findEffectValueErrors = (content: string): boolean => {
            const data = content.split(":");
            if (data.length !== effectNameSplit.length) {
                return true;
            }

            return data.filter(x => Number.isNaN(parseFloat(x))).length > 0;
        };

        if (!(parseInt(rarity) >= 0 && parseInt(rarity) < 5)) {
            return true;
        }

        if (!(parseInt(cp) > 0)) {
            return true;
        }

        if (findEffectValueErrors(effectValues)) {
            return true;
        }

        if (parts.length === 6) {
            if (findEffectValueErrors(parts[5])) {
                return true;
            }
        }
    });

    const charms = charmLines.map(([a]) => a);

    if (badLines.length > 0) {
        await sendReply(interaction, `Bad charm data on lines: ${badLines.map(([, v]) => v).join(", ")}!`);
        return;
    }

    const result = await queue.evaluate(interaction.user.id, task.owner, task.name, config.weights, charms, cp, {maxUpgrades, upgradePenalty, });

    if (!result.success) {
        await sendReply(interaction, result.error);
        return;
    }

    // mtce numbers charms in file order, with an upgradable charm followed by its "(u)" copy (one rarity higher)
    const entries: ChosenCharm[] = charms.flatMap(x => {
        const parts = x.split(";");
        const name = parts[1];
        const rarity = parseInt(parts[0]);
        const charmPower = parseInt(parts[2]);
        const base = {name, charmPower, rarity, upgraded: false, };
        return parts.length === 6 ? [base, {name: `${name} (u)`, charmPower, rarity: rarity + 1, upgraded: true, }] : [base];
    });

    await sendReply(interaction, formatEvalMessage({
        note: result.complete ? undefined :
            `:warning: **Timed out after ${fmtElapsed(getConfig().timeout * 1000)}.** This is the best build found so far and might not be optimal.`,
        weight: result.weight,
        charms: result.charms.map(x => entries[x]),
        maxCp: cp,
        maxUpgrades,
        stats: result.stats,
        statsAnsi: result.statsAnsi,
    }));
}

export const COMMANDS: Record<string, SubCommandNode | ExecuteNode> = {
    findeffect: {
        description: "Queries charm effects.",
        options: {
            query: {
                type: "string",
                description: "The query",
            },
        },
        async executor(interaction) {
            const query = interaction.options.getString("query", true);
            const parts = query.split(/\s+/).map(part => part.replace(/\W+/g, "").toLowerCase());

            const results = [...NAME_TO_ID.keys()].filter(effectName => parts.filter(part => effectName.indexOf(part) === -1).length === 0).join("\n");
            if (results.length === 0) {
                await sendReply(interaction, `No results found for query "${query}"`);
                return;
            }

            await sendReply(interaction, "Effects:```\n" + results + "\n```");
        },
    },
    evaluate: {
        description: "Evaluates charms.",
        options: {
            name: {
                type: "string",
                description: "The name of the config",
            },
            data: {
                type: "file",
                description: "The charm data file",
            },
            cp: {
                type: "integer",
                description: "The charm power (default: the config's charm_power, else 15)",
                min: 1,
                max: 15,
                required: false,
            },
            max_upgrades: {
                type: "integer",
                description: "Max upgraded (u) charms per set (0 = only charms as they are), default no limit",
                min: 0,
                max: 7,
                required: false,
            },
            upgrade_penalty: {
                type: "integer",
                description: "Cost of each upgraded charm, as an effect with this weight going 0 to cap (default 0)",
                min: 0,
                max: 1000000,
                required: false,
            },
            owner: {
                type: "user",
                description: "The user that holds the config, by default the sender",
                required: false,
            },
        },
        async executor(interaction, userData, queue) {
            const name = interaction.options.getString("name", true);
            const charmDataUrl = interaction.options.getAttachment("data", true).url;
            const cp = interaction.options.getInteger("cp") ?? undefined;
            const maxUpgrades = interaction.options.getInteger("max_upgrades") ?? undefined;
            const upgradePenalty = interaction.options.getInteger("upgrade_penalty") ?? undefined;
            const owner = interaction.options.getUser("owner") ?? interaction.user;

            const job: UserEvalJob = {cp, name, owner: owner.id, charmDataUrl, maxUpgrades, upgradePenalty, };

            userData.setLatestJob(interaction.user.id, job);
            await doEvaluateCharms(interaction, userData, queue, job);
        },
    },
    rerun: {
        description: "Re-run the latest evaluate task.",
        options: {},
        async executor(interaction, userData, queue) {
            const lastJob = userData.getLatestJob(interaction.user.id);

            if (lastJob === undefined) {
                await sendReply(interaction, "No past job for user.");
                return;
            }

            await doEvaluateCharms(interaction, userData, queue, lastJob);
        },
    },
    queue: {
        description: "Examines the task queue.",
        options: {},
        async executor(interaction, _, queue) {
            const mention = (id: string) => `<@${id}>`;
            const currTask = queue.getCurrTask();
            const waiting = queue.getEntries();
            await sendReply(
                interaction,
                [
                    currTask === undefined ? "No current task" : `Current task: ${runningStatus(currTask, waiting.length, mention)}`,
                    ...waiting.map((task, index) =>
                        `#${index + 1}: ${describeTask(task, mention)}, waiting for ${fmtElapsed(Date.now() - task.creationTime)}`)
                ].join("\n")
            );
        },
    },
    help: {
        description: "Documentation.",
        options: {},
        async executor(interaction) {
            await sendReply(interaction, `
            ## Charm Eval Bot Help Manual

            **Commands:**

            **/findeffect** - Query charm effects by name.  
            Usage: \`/findeffect query:<text>\`  
            - \`query\`: Space-separated terms to search in effect names.
            You can use this to get effect names for making the config; see \`/config create\`

            **/evaluate** - Evaluate charms using a config.  
            Usage: \`/evaluate name:<config> data:<file> [cp:<1-15>] [max_upgrades:<0-7>] [upgrade_penalty:<n>] [owner:<user>]\`  
            - \`name\`: Config name.  
            - \`data\`: Charm data file.  
            - \`cp\`: Charm power (1-15; default: the config's \`charm_power\`, else 15).  
            - \`max_upgrades\`: Max upgraded (u) charms in the set (0 = only charms as they are; default: the config's max_upgrades, else no limit).  
            - \`upgrade_penalty\`: Cost of each upgraded charm, counted like an effect with this weight going from 0 to its cap (default: the config's upgrade_penalty, else 0).  
            - \`owner\`: Config owner (defaults to you).
            The config should be created by \`/config create\`. The charm data file should be obtained via flowey mod (version 1.8 or above).
            With the mod, you can hover over charms and press \`i\`. After you add all charms, run \`/fma copycharmdata\`, and paste the result into a file.
            Then you should upload that file as the attachment for \`data\`.

            **/rerun** - Re-run your last evaluation.  
            Usage: \`/rerun\`

            **/queue** - View current evaluation queue.  
            Usage: \`/queue\`
            `.split("\n").map(x => x.trim()).join("\n"));

            await sendReply(interaction, ` 
            **/config** - Manage configurations.  
            Subcommands:  
            - **get**: View a config.  
              Usage: \`/config get name:<name> [owner:<user>]\`  
            - **delete**: Delete a config.  
              Usage: \`/config delete name:<name> [owner:<user>]\`  
              *Requires permission if modifying another user's config.*  
            - **fork**: Copy a config.  
              Usage: \`/config fork target_name:<name> source_name:<name> [target_owner:<user>] [source_owner:<user>]\`  
            - **import**: Create or replace a config by pasting it into a form.  
              Usage: \`/config import name:<name> [owner:<user>]\`  
              *Paste the same text as an mtce .conf file: optional \`charm_power\`, \`max_upgrades\`, \`upgrade_penalty\` lines, then \`[weights]\` and one \`effect = weight\` per line. Comments with #. These settings become the config's defaults for \`/evaluate\`.*  
            - **create**: Create a new config.  
              Usage: \`/config create name:<name> [owner:<user>] [data:<file>]\`  
              *The optional file uses the same format as \`/config import\`; names can be obtained via \`/findeffect\`.*  
            - **list**: List user's configs.  
              Usage: \`/config list [owner:<user>]\`  
            - **edit**: Modify a config's weight.  
              Usage: \`/config edit name:<name> effect:<effect> weight:<value> [owner:<user>]\`  
              - \`weight\`: Integer between -2000000000 and 2000000000.

            ## Example Usage 
            First you should create a config via \`/config create\`. For example, if you wanted to create a config for flame charms, you should:
            1. Look up the name of the effect via \`/findeffect\`, so for example you may run \`/findeffect query:meteor cooldown\`
            2. Create the config with \`/config create\`
            3. Use \`/config edit\` with the effect name from step 1 and give it a weight; this assigns the relative importance of an effect.
            4. Obtain charm data via flowey mod.
            5. Use \`/evaluate\`
            `.split("\n").map(x => x.trim()).join("\n"));
        },
    },
    config: {
        description: "Config manipulation commands.",
        children: {
            get: {
                description: "Reads a configuration.",
                options: {
                    name: {
                        type: "string",
                        description: "The name of the config",
                    },
                    owner: {
                        type: "user",
                        description: "The user that holds the config, by default the sender",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const name = interaction.options.getString("name", true);
                    const owner = interaction.options.getUser("owner") ?? interaction.user;

                    if (!await validateConfigName(interaction, name)) {
                        return;
                    }

                    const config = await tryFetchConfig(interaction, userData, owner, name);

                    if (config === undefined) {
                        return;
                    }

                    if (Object.keys(config.weights).length === 0 && config.settings === undefined) {
                        await sendReply(interaction, "Empty config.");
                    } else {
                        // same format /config import accepts, so it can be copied, edited and pasted back
                        await sendReply(interaction, "```ini\n" + formatConfigText(config, x => NAME_TO_ID.has(x)) + "\n```");
                    }
                },
            },
            delete: {
                description: "Deletes a configuration.",
                options: {
                    name: {
                        type: "string",
                        description: "The name of the config",
                    },
                    owner: {
                        type: "user",
                        description: "The user that holds the config, by default the sender",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const name = interaction.options.getString("name", true);
                    const owner = interaction.options.getUser("owner") ?? interaction.user;

                    if (!await validateConfigName(interaction, name)) {
                        return;
                    }

                    if (interaction.user.id !== owner.id && !userData.isAdmin(interaction.user.id)) {
                        await sendReply(interaction, "You do not have permission to delete this config!");
                        return;
                    }

                    if (!userData.deleteConfig(owner.id, name)) {
                        await sendReply(interaction, `Config ${owner}:${name} does not exist.`);
                    }
                    await sendReply(interaction, `Deleted config ${owner}:${name}.`);
                },
            },
            fork: {
                description: "Copies a configuration from another user.",
                options: {
                    target_name: {
                        type: "string",
                        description: "The name of the copied config",
                    },
                    source_name: {
                        type: "string",
                        description: "The name of the source config to copy from",
                    },
                    target_owner: {
                        type: "user",
                        description: "The user to copy the config to, by default the sender",
                        required: false,
                    },
                    source_owner: {
                        type: "user",
                        description: "The name of the owner of the source config, by default the sender",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const targetName = interaction.options.getString("target_name", true);
                    const targetOwner = interaction.options.getUser("target_owner") ?? interaction.user;
                    const sourceName = interaction.options.getString("source_name", true);
                    const sourceOwner = interaction.options.getUser("source_owner") ?? interaction.user;

                    if (!await validateConfigName(interaction, targetName)) {
                        return;
                    }

                    if (!await validateConfigName(interaction, sourceName)) {
                        return;
                    }

                    const config = userData.fetchConfig(sourceOwner.id, sourceName);

                    if (config === undefined) {
                        await sendReply(interaction, `Config ${sourceOwner}:${sourceName} not found.`);
                        return;
                    }

                    if (interaction.user.id !== targetOwner.id && !userData.isAdmin(interaction.user.id)) {
                        await sendReply(interaction, "You do not have permission to fork a config to this user!");
                        return;
                    }

                    if (!userData.createConfig(targetOwner.id, targetName, await validateAndNormalizeConfig(interaction, config))) {
                        await sendReply(interaction, `Config ${targetOwner}:${targetName} already exists.`);
                        return;
                    }

                    await sendReply(interaction, `Copied ${sourceOwner}:${sourceName} -> ${targetOwner}:${targetName}`);
                },
            },
            create: {
                description: "Creates a configuration.",
                options: {
                    name: {
                        type: "string",
                        description: "The name of the config",
                    },
                    owner: {
                        type: "user",
                        description: "The user that holds the config, by default the sender",
                        required: false,
                    },
                    data: {
                        type: "file",
                        description: "Configuration data",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const name = interaction.options.getString("name", true);
                    const owner = interaction.options.getUser("owner") ?? interaction.user;
                    const attachmentUrl = interaction.options.getAttachment("data")?.url;

                    if (!await validateConfigName(interaction, name)) {
                        return;
                    }

                    let config: UserWeightConfig = {weights: {}, };

                    if (attachmentUrl !== undefined) {
                        const request = await fetch(attachmentUrl);
                        const parsed = parseConfigText(await request.text(), x => NAME_TO_ID.has(x));

                        if (!parsed.ok) {
                            await sendReply(interaction, formatParseErrors(parsed.errors));
                            return;
                        }

                        config = parsed.config;
                    }

                    if (interaction.user.id !== owner.id && !userData.isAdmin(interaction.user.id)) {
                        await sendReply(interaction, "You do not have permission to create a config to this user!");
                        return;
                    }

                    userData.createConfig(owner.id, name, await validateAndNormalizeConfig(interaction, config), true);
                    await sendReply(interaction, `Created config ${owner}:${name}.`);
                },
            },
            import: {
                description: "Create or replace a config by pasting it into a form (charm_power, [weights], ...).",
                options: {
                    name: {
                        type: "string",
                        description: "The name of the config",
                    },
                    owner: {
                        type: "user",
                        description: "The user that holds the config, by default the sender",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const name = interaction.options.getString("name", true);
                    const owner = interaction.options.getUser("owner") ?? interaction.user;

                    if (!await validateConfigName(interaction, name)) {
                        return;
                    }

                    if (name.length > CONFIG_NAME_MAX) {
                        await sendReply(interaction, `Name ${name} is too long (max ${CONFIG_NAME_MAX} characters).`);
                        return;
                    }

                    if (interaction.user.id !== owner.id && !userData.isAdmin(interaction.user.id)) {
                        await sendReply(interaction, "You do not have permission to create a config to this user!");
                        return;
                    }

                    // prefill with the current config when replacing one, so it can be edited in place
                    const existing = userData.fetchConfig(owner.id, name);

                    const input = new TextInputBuilder()
                        .setCustomId(CONFIG_IMPORT_FIELD)
                        .setLabel("Config (same format as an mtce .conf file)")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMaxLength(4000)
                        .setPlaceholder("charm_power = 15\n[weights]\nfirework_blast_cooldown = 10\nfirework_blast_damage = 10");

                    if (existing !== undefined) {
                        const current = formatConfigText(existing);
                        if (current.length <= 4000) {
                            input.setValue(current);
                        }
                    }

                    const modal = new ModalBuilder()
                        .setCustomId(`${CONFIG_IMPORT_PREFIX}${owner.id}:${name}`)
                        .setTitle(`${existing !== undefined ? "Replace" : "Create"} config ${name}`.slice(0, 45))
                        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

                    await interaction.showModal(modal);
                },
            },
            list: {
                description: "List user configs.",
                options: {
                    owner: {
                        type: "user",
                        description: "The user that holds the config, by default the sender",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const owner = interaction.options.getUser("owner") ?? interaction.user;
                    const configs = userData.fetchConfigs(owner.id);
                    await sendReply(
                        interaction,
                        configs.length === 0 ?
                            `${owner} has no configs.` :
                            `${owner} has the following configs: ${configs.join(", ")}`
                    );
                },
            },
            edit: {
                description: "Edit a configuration field.",
                options: {
                    name: {
                        type: "string",
                        description: "The name of the config",
                    },
                    effect: {
                        type: "string",
                        description: "The effect to change",
                    },
                    weight: {
                        type: "string",
                        description: "The new weight",
                    },
                    owner: {
                        type: "user",
                        description: "The user that holds the config, by default the sender",
                        required: false,
                    },
                },
                async executor(interaction, userData) {
                    const name = interaction.options.getString("name", true);
                    const effect = interaction.options.getString("effect", true);
                    const weight = interaction.options.getString("weight", true);
                    const owner = interaction.options.getUser("owner") ?? interaction.user;

                    if (!await validateConfigName(interaction, name)) {
                        return;
                    }

                    if (!NAME_TO_ID.has(effect)) {
                        await sendReply(interaction, `Unknown effect ${effect}, try using \`/findeffect\`.`);
                        return;
                    }

                    const config = userData.fetchConfig(owner.id, name);

                    if (config === undefined) {
                        await sendReply(interaction, `Config ${owner}:${name} not found.`);
                        return;
                    }

                    if (interaction.user.id !== owner.id && !userData.isAdmin(interaction.user.id)) {
                        await sendReply(interaction, "You do not have permission to create a config to this user!");
                        return;
                    }

                    if (!validateWeight(weight)) {
                        await sendReply(interaction, `Illegal value for weight: ${weight}`);
                        return;
                    }

                    config.weights[effect] = weight;
                    userData.setConfig(owner.id, name, await validateAndNormalizeConfig(interaction, config));

                    await sendReply(interaction, "Successfully edited config. New config:\n```ini\n" + formatConfigText(config) + "\n```");
                },
            },
        },
    },
};

