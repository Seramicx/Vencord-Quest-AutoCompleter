/**
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    autoAcceptQuests: {
        type: OptionType.BOOLEAN,
        description: "Automatically accept all available quests",
        default: false,
        restartNeeded: false
    },
    logProgress: {
        type: OptionType.BOOLEAN,
        description: "Log quest completion progress to console",
        default: true,
        restartNeeded: false
    }
});

const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];

// ── Store references ──────────────────────────────────────────────────────────
let ApplicationStreamingStore: any;
let RunningGameStore: any;
let QuestsStore: any;
let ChannelStore: any;
let GuildChannelStore: any;
let FluxDispatcher: any;
let api: any;
let isApp: boolean;

// ── Runtime state ─────────────────────────────────────────────────────────────
let initialized = false;
let processingQuests = false;
let questQueue: any[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let fluxUnsubs: (() => void)[] = [];
let sessionDebounce: ReturnType<typeof setTimeout> | null = null;

// ── Utility ───────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function log(...args: any[]) {
    if (settings.store.logProgress) {
        console.log("[QuestAutocompleter]", ...args);
    }
}

function getTaskConfig(quest: any) {
    return quest.config.taskConfig ?? quest.config.taskConfigV2;
}

function isCompletable(quest: any): boolean {
    if (new Date(quest.config.expiresAt).getTime() <= Date.now()) return false;
    const tasks = getTaskConfig(quest)?.tasks;
    if (!tasks) return false;
    return SUPPORTED_TASKS.some(t => tasks[t] != null);
}

function isEnrolled(quest: any): boolean {
    return !!quest.userStatus?.enrolledAt;
}

function isCompleted(quest: any): boolean {
    return !!quest.userStatus?.completedAt;
}

// ── Store init ────────────────────────────────────────────────────────────────
function initStores(): boolean {
    if (initialized) return true;

    try {
        const wpRequire = (window as any).webpackChunkdiscord_app.push([[Symbol()], {}, (r: any) => r]);
        (window as any).webpackChunkdiscord_app.pop();

        ApplicationStreamingStore = Object.values(wpRequire.c).find((x: any) =>
            x?.exports?.Z?.__proto__?.getStreamerActiveStreamMetadata
        )?.exports?.Z;

        if (!ApplicationStreamingStore) {
            ApplicationStreamingStore = Object.values(wpRequire.c).find((x: any) =>
                x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata
            )?.exports?.A;
            RunningGameStore  = Object.values(wpRequire.c).find((x: any) => x?.exports?.Ay?.getRunningGames)?.exports?.Ay;
            QuestsStore       = Object.values(wpRequire.c).find((x: any) => x?.exports?.A?.__proto__?.getQuest)?.exports?.A;
            ChannelStore      = Object.values(wpRequire.c).find((x: any) => x?.exports?.A?.__proto__?.getAllThreadsForParent)?.exports?.A;
            GuildChannelStore = Object.values(wpRequire.c).find((x: any) => x?.exports?.Ay?.getSFWDefaultChannel)?.exports?.Ay;
            FluxDispatcher    = Object.values(wpRequire.c).find((x: any) => x?.exports?.h?.__proto__?.flushWaitQueue)?.exports?.h;
            api               = Object.values(wpRequire.c).find((x: any) => x?.exports?.Bo?.get)?.exports?.Bo;
        } else {
            RunningGameStore  = Object.values(wpRequire.c).find((x: any) => x?.exports?.ZP?.getRunningGames)?.exports?.ZP;
            QuestsStore       = Object.values(wpRequire.c).find((x: any) => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z;
            ChannelStore      = Object.values(wpRequire.c).find((x: any) => x?.exports?.Z?.__proto__?.getAllThreadsForParent)?.exports?.Z;
            GuildChannelStore = Object.values(wpRequire.c).find((x: any) => x?.exports?.ZP?.getSFWDefaultChannel)?.exports?.ZP;
            FluxDispatcher    = Object.values(wpRequire.c).find((x: any) => x?.exports?.Z?.__proto__?.flushWaitQueue)?.exports?.Z;
            api               = Object.values(wpRequire.c).find((x: any) => x?.exports?.tn?.get)?.exports?.tn;
        }

        if (!QuestsStore || !FluxDispatcher || !api) {
            console.error("[QuestAutocompleter] Failed to find required stores");
            return false;
        }

        isApp = typeof (window as any).DiscordNative !== "undefined";
        initialized = true;
        log("Stores initialized, isApp =", isApp);
        return true;
    } catch (e) {
        console.error("[QuestAutocompleter] Init failed:", e);
        return false;
    }
}

// ── Auto-accept ───────────────────────────────────────────────────────────────
async function enrollQuest(quest: any): Promise<boolean> {
    const name = quest.config.messages.questName;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await api.post({
                url: `/quests/${quest.id}/enroll`,
                body: {
                    location: 11,
                    is_targeted: false,
                    metadata_raw: null,
                    metadata_sealed: null,
                    traffic_metadata_raw: null
                }
            });

            if (res?.status === 429) {
                const waitMs = ((res.body?.retry_after ?? 5) + 1) * 1000;
                log(`Rate limited on "${name}" (attempt ${attempt}/${MAX_RETRIES}) – waiting ${Math.ceil(waitMs / 1000)}s...`);
                if (attempt < MAX_RETRIES) await sleep(waitMs);
                continue;
            }

            log(`Auto-accepted: ${name}`);
            return true;

        } catch (e: any) {
            const status: number = e?.status ?? e?.res?.status ?? 0;
            const body: any      = e?.body   ?? e?.res?.body   ?? {};

            if (status === 429) {
                const waitMs = ((body?.retry_after ?? 5) + 1) * 1000;
                log(`Rate limited on "${name}" (attempt ${attempt}/${MAX_RETRIES}) – waiting ${Math.ceil(waitMs / 1000)}s...`);
                if (attempt < MAX_RETRIES) await sleep(waitMs);
                continue;
            }

            log(`Failed to accept "${name}" (status ${status}):`, body?.message ?? e);
            return false;
        }
    }

    log(`Gave up enrolling "${name}" after ${MAX_RETRIES} rate-limited attempts`);
    return false;
}

async function autoAcceptAvailableQuests(): Promise<boolean> {
    if (!settings.store.autoAcceptQuests) return false;
    if (!QuestsStore?.quests) return false;

    const unaccepted = [...QuestsStore.quests.values()].filter(q =>
        !isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );

    if (unaccepted.length === 0) return false;

    log(`Auto-accepting ${unaccepted.length} quest(s)...`);
    let enrolledAny = false;

    for (const q of unaccepted) {
        const ok = await enrollQuest(q);
        if (ok) enrolledAny = true;
        await sleep(3000);
    }

    return enrolledAny;
}

// ── Queue management ──────────────────────────────────────────────────────────
function syncQueueFromStore() {
    if (!QuestsStore?.quests) return;

    const enrolled = [...QuestsStore.quests.values()].filter(q =>
        isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );

    let added = 0;
    for (const quest of enrolled) {
        if (!questQueue.find(q => q.id === quest.id)) {
            questQueue.push(quest);
            added++;
            log(`Queued: ${quest.config.messages.questName}`);
        }
    }

    if (added > 0) log(`${added} quest(s) added to queue (total: ${questQueue.length})`);

    if (!processingQuests && questQueue.length > 0) {
        log("Starting processing loop...");
        doJob();
    }
}

function scan() {
    if (!initialized) return;

    // Sync already-enrolled quests immediately so the queue starts without delay
    syncQueueFromStore();

    // Auto-accept runs in the background; syncs again when done so newly
    // enrolled quests get picked up without blocking the existing queue
    autoAcceptAvailableQuests().then(enrolled => {
        if (enrolled) setTimeout(() => syncQueueFromStore(), 1500);
    });
}

// ── Session init ──────────────────────────────────────────────────────────────
function startSession() {
    // Debounce rapid CONNECTION_OPEN bursts (multiple gateway shards)
    if (sessionDebounce !== null) clearTimeout(sessionDebounce);

    sessionDebounce = setTimeout(() => {
        sessionDebounce  = null;
        initialized      = false;
        processingQuests = false;
        questQueue       = [];

        if (pollInterval !== null) {
            clearInterval(pollInterval);
            pollInterval = null;
        }

        // Initialize stores immediately — no extra delay.
        // Quest DATA may not have arrived yet (QUESTS_FETCH_SUCCESS handles that),
        // but the store objects themselves are ready as soon as CONNECTION_OPEN fires.
        if (!initStores()) return;
        pollInterval = setInterval(() => scan(), 60_000);

        // Do an immediate scan in case QUESTS_FETCH_SUCCESS already fired
        // (e.g. plugin enabled mid-session) or quests are already in the store
        scan();
    }, 500); // 500ms is enough to let the last shard connect; no need for 2s
}

// ── Processing loop ───────────────────────────────────────────────────────────
function doJob() {
    const quest = questQueue.pop();
    if (!quest) {
        processingQuests = false;
        log("All queued quests done.");
        return;
    }

    processingQuests = true;

    const pid             = Math.floor(Math.random() * 30000) + 1000;
    const applicationId   = quest.config.application.id;
    const applicationName = quest.config.application.name;
    const questName       = quest.config.messages.questName;
    const taskConfig      = getTaskConfig(quest);
    const taskName        = SUPPORTED_TASKS.find(x => taskConfig.tasks[x] != null)!;
    const secondsNeeded   = taskConfig.tasks[taskName].target;
    let secondsDone       = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    // ── WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE ───────────────────────────────────
    if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
        const maxFuture = 10, speed = 7, interval = 1;
        const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
        let completed = false;

        (async () => {
            try {
                while (true) {
                    const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                    const diff = maxAllowed - secondsDone;
                    const timestamp = secondsDone + speed;

                    if (diff >= speed) {
                        const res = await api.post({
                            url: `/quests/${quest.id}/video-progress`,
                            body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                        });
                        completed = res.body.completed_at != null;
                        secondsDone = Math.min(secondsNeeded, timestamp);
                    }

                    if (timestamp >= secondsNeeded) break;
                    await sleep(interval * 1000);
                }

                if (!completed) {
                    await api.post({
                        url: `/quests/${quest.id}/video-progress`,
                        body: { timestamp: secondsNeeded }
                    });
                }

                log(`Completed: ${questName}`);
            } catch (e) {
                log(`Error completing "${questName}":`, e);
            }
            doJob();
        })();

        log(`Spoofing video: ${questName}`);

    // ── PLAY_ON_DESKTOP ───────────────────────────────────────────────────────
    } else if (taskName === "PLAY_ON_DESKTOP") {
        if (!isApp) {
            log(`${questName} requires the desktop app – skipping`);
            doJob();
            return;
        }

        api.get({ url: `/applications/public?application_ids=${applicationId}` })
            .then((res: any) => {
                const appData = res.body?.[0];

                if (!appData) {
                    log(`No app data returned for "${questName}" – skipping`);
                    doJob();
                    return;
                }

                // Find a win32 executable; fall back to any executable; fall back to a generic name
                const win32Exe = appData.executables?.find((x: any) => x.os === "win32");
                const anyExe   = appData.executables?.[0];
                const exeName  = (win32Exe ?? anyExe)?.name?.replace(">", "") ?? `${appData.name}.exe`;

                const fakeGame = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                    exeName,
                    exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                    hidden: false,
                    isLauncher: false,
                    id: applicationId,
                    name: appData.name,
                    pid,
                    pidPath: [pid],
                    processName: appData.name,
                    start: Date.now(),
                };

                const realGames           = RunningGameStore.getRunningGames();
                const realGetRunningGames = RunningGameStore.getRunningGames;
                const realGetGameForPID   = RunningGameStore.getGameForPID;

                RunningGameStore.getRunningGames = () => [fakeGame];
                RunningGameStore.getGameForPID   = (p: number) => (p === fakeGame.pid ? fakeGame : undefined);
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });

                const fn = (data: any) => {
                    try {
                        const progress = quest.config.configVersion === 1
                            ? data.userStatus.streamProgressSeconds
                            : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);

                        log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                        if (progress >= secondsNeeded) {
                            log(`Completed: ${questName}`);
                            RunningGameStore.getRunningGames = realGetRunningGames;
                            RunningGameStore.getGameForPID   = realGetGameForPID;
                            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                            doJob();
                        }
                    } catch (e) {
                        log(`Error in heartbeat handler for "${questName}":`, e);
                        RunningGameStore.getRunningGames = realGetRunningGames;
                        RunningGameStore.getGameForPID   = realGetGameForPID;
                        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                        doJob();
                    }
                };

                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                log(`Spoofed game: ${applicationName} – ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left`);
            })
            .catch((e: any) => {
                log(`Failed to fetch app data for "${questName}":`, e);
                doJob();
            });

    // ── STREAM_ON_DESKTOP ─────────────────────────────────────────────────────
    } else if (taskName === "STREAM_ON_DESKTOP") {
        if (!isApp) {
            log(`${questName} requires the desktop app – skipping`);
            doJob();
            return;
        }

        const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
        ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
            id: applicationId,
            pid,
            sourceName: null
        });

        const fn = (data: any) => {
            try {
                const progress = quest.config.configVersion === 1
                    ? data.userStatus.streamProgressSeconds
                    : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);

                log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                if (progress >= secondsNeeded) {
                    log(`Completed: ${questName}`);
                    ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                    doJob();
                }
            } catch (e) {
                log(`Error in heartbeat handler for "${questName}":`, e);
                ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
                FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                doJob();
            }
        };

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        log(`Spoofed stream: ${applicationName} – ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left (need 1+ in VC)`);

    // ── PLAY_ACTIVITY ─────────────────────────────────────────────────────────
    } else if (taskName === "PLAY_ACTIVITY") {
        const channelId =
            ChannelStore.getSortedPrivateChannels()[0]?.id ??
            (Object.values(GuildChannelStore.getAllGuilds()) as any[])
                .find((x: any) => x?.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;

        if (!channelId) {
            log("No suitable channel found for PLAY_ACTIVITY – skipping");
            doJob();
            return;
        }

        const streamKey = `call:${channelId}:1`;

        (async () => {
            try {
                log(`Activity: ${questName}`);
                while (true) {
                    const res = await api.post({
                        url: `/quests/${quest.id}/heartbeat`,
                        body: { stream_key: streamKey, terminal: false }
                    });
                    const progress = res.body.progress.PLAY_ACTIVITY.value;
                    log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                    if (progress >= secondsNeeded) {
                        await api.post({
                            url: `/quests/${quest.id}/heartbeat`,
                            body: { stream_key: streamKey, terminal: true }
                        });
                        break;
                    }

                    await sleep(20000);
                }
                log(`Completed: ${questName}`);
            } catch (e) {
                log(`Error completing "${questName}":`, e);
            }
            doJob();
        })();
    }
}

// ── Plugin entry point ────────────────────────────────────────────────────────
export default definePlugin({
    name: "QuestAutocompleter",
    description: "Automatically completes Discord quests. Enable 'Auto Accept Quests' in settings to also enroll in new quests automatically.",
    authors: [Devs.Nobody],
    settings,

    start() {
        log("Starting...");

        const bootstrapFlux = (): any => {
            try {
                const wpRequire = (window as any).webpackChunkdiscord_app.push([[Symbol()], {}, (r: any) => r]);
                (window as any).webpackChunkdiscord_app.pop();
                return (
                    Object.values(wpRequire.c).find((x: any) => x?.exports?.Z?.__proto__?.flushWaitQueue)?.exports?.Z ??
                    Object.values(wpRequire.c).find((x: any) => x?.exports?.h?.__proto__?.flushWaitQueue)?.exports?.h
                );
            } catch { return null; }
        };

        const earlyFlux = bootstrapFlux();
        if (!earlyFlux) {
            console.error("[QuestAutocompleter] Could not bootstrap FluxDispatcher");
            return;
        }

        // CONNECTION_OPEN covers: first load, page reload, account switch
        const onConnectionOpen = () => {
            log("CONNECTION_OPEN – starting new session...");
            startSession();
        };

        // Fires when Discord finishes fetching the quest list from the server.
        // This is the key trigger — quest data often arrives during or after
        // the CONNECTION_OPEN debounce window, so we must handle it here.
        // Also ensures stores are initialized if the event fires before startSession completes.
        const onQuestsFetched = () => {
            log("QUESTS_FETCH_SUCCESS – quests loaded, scanning...");
            if (!initialized) initStores();
            scan();
        };

        // Instant detection when you manually accept a quest
        const onStatusUpdate = () => {
            log("QUEST_USER_STATUS_UPDATE – syncing queue...");
            setTimeout(() => syncQueueFromStore(), 500);
        };

        earlyFlux.subscribe("CONNECTION_OPEN", onConnectionOpen);
        earlyFlux.subscribe("QUESTS_FETCH_SUCCESS", onQuestsFetched);
        earlyFlux.subscribe("QUEST_USER_STATUS_UPDATE", onStatusUpdate);

        fluxUnsubs = [
            () => earlyFlux.unsubscribe("CONNECTION_OPEN", onConnectionOpen),
            () => earlyFlux.unsubscribe("QUESTS_FETCH_SUCCESS", onQuestsFetched),
            () => earlyFlux.unsubscribe("QUEST_USER_STATUS_UPDATE", onStatusUpdate),
        ];

        // If enabled mid-session via plugin manager, CONNECTION_OPEN won't fire
        // startSession() has a guard so if CONNECTION_OPEN fires first within
        // the 2s window, the manual call here becomes a no-op
        startSession();
    },

    stop() {
        log("Stopping...");

        for (const unsub of fluxUnsubs) unsub();
        fluxUnsubs = [];

        if (pollInterval !== null) {
            clearInterval(pollInterval);
            pollInterval = null;
        }

        questQueue       = [];
        processingQuests = false;
        initialized      = false;
        if (sessionDebounce !== null) { clearTimeout(sessionDebounce); sessionDebounce = null; }
    }
});
