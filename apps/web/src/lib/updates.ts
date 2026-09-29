import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";
import { flushDrafts } from "./drafts.js";
import { getLink, pauseForUpdate } from "./link.js";
import { isTauri } from "./platform.js";
import { session } from "./session.js";
import { readSetting, writeSetting } from "./storage.js";
import { UpdateController, type UpdateChannel } from "./updateController.js";
import { radioBusyForUpdate } from "./updateSafety.js";

const CHANNEL_KEY = "meshnet.updates.channel";
const AUTO_KEY = "meshnet.updates.auto";
const savedChannel = readSetting<unknown>(CHANNEL_KEY, null);
const initialChannel: UpdateChannel = savedChannel === "dev" || savedChannel === "stable" ? savedChannel : __APP_VERSION__.includes("-") ? "dev" : "stable";
const PERIOD = 6 * 60 * 60_000;

export const updates = new UpdateController(async (channel) => {
  const { Update } = await import("@tauri-apps/plugin-updater");
  const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>("desktop_check_update", { channel });
  return metadata ? new Update(metadata) : null;
}, initialChannel);

interface DesktopInfo { version: string; supported: boolean; channel: UpdateChannel }
let info = { version: __APP_VERSION__, supported: false, ready: false, error: null as string | null, open: false, auto: readSetting<boolean>(AUTO_KEY, true) };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const emit = (patch: Partial<typeof info>) => { info = { ...info, ...patch }; for (const listener of listeners) listener(); };
export const useDesktopUpdateInfo = () => useSyncExternalStore(subscribe, () => info);
export const useUpdates = () => useSyncExternalStore(updates.subscribe, updates.getState);
export const openUpdates = () => emit({ open: true });
export const closeUpdates = () => { if (updates.getState().phase !== "installing") emit({ open: false }); };
export function chooseUpdateChannel(channel: UpdateChannel): void {
  if (updates.setChannel(channel)) writeSetting(CHANNEL_KEY, channel);
}
export function setAutomaticChecks(auto: boolean): void {
  writeSetting(AUTO_KEY, auto);
  emit({ auto });
  if (auto) void automaticCheck();
}

let lastAttempt = 0;
let initializing: Promise<void> | null = null;
async function automaticCheck(): Promise<void> {
  if (!info.supported || !info.auto || Date.now() - lastAttempt < PERIOD) return;
  // A found update is looked for again too, so the version on show stays the feed's newest.
  if (!["idle", "current", "available"].includes(updates.getState().phase)) return;
  lastAttempt = Date.now();
  await updates.check();
}
export function initializeUpdates(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  initializing ??= (async () => {
    try {
      const native = await invoke<DesktopInfo>("desktop_update_info");
      emit({ version: native.version, supported: native.supported, ready: true });
      if (savedChannel !== "stable" && savedChannel !== "dev") updates.setChannel(native.channel);
      void automaticCheck();
      setInterval(() => void automaticCheck(), PERIOD);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void automaticCheck();
      });
    } catch (error) {
      emit({ ready: true, error: t("app.update.error.init", { reason: errorText(error) }) });
    }
  })();
  return initializing;
}

async function prepareInstallation(): Promise<() => Promise<void>> {
  const deadline = Date.now() + 45_000;
  while (session.hasPendingCommands || radioBusyForUpdate(session.getState()) || getLink().phase === "connecting") {
    if (Date.now() >= deadline) throw new Error(t("app.update.error.radioBusy"));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  flushDrafts();
  // Fail while the radio is still connected if storage is unavailable.
  await session.flush();
  const resume = await pauseForUpdate();
  try {
    await session.flush();
  } catch (error) {
    await resume().catch(() => undefined);
    throw error;
  }
  return resume;
}
export const installUpdate = () => updates.install(prepareInstallation);
