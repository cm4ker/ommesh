/**
 * Moving to another radio, the app's side of it: saving the connected radio
 * as a copy, picking a copy to write onto it, writing it with
 * `session.restoreRadio` and, once the radio is back with the copy's key,
 * bringing its chats and this app's settings for it in. Kept here too: when
 * each radio's copy was last saved, and which radio each node moved to, so
 * that the old one is told apart when it is connected again.
 */

import { useSyncExternalStore } from "react";
import type { RestoreStep, SessionState } from "@meshnet/meshcore";
import { planImport } from "../history/plan.js";
import { getLink } from "../link.js";
import { setStack } from "../nav.js";
import { saveFile } from "../saveFile.js";
import { session } from "../session.js";
import { adoptSettings, settingsSnapshot } from "../sharedSettings.js";
import { readSetting, writeSetting } from "../storage.js";
import { toast } from "../toast.js";
import { backupFileName, BackupFileError, parseBackup, writeBackup } from "./format.js";
import { copyOf, movedSettings, partsAvailable, planRestore, type RestorePart, type RestorePlan } from "./plan.js";
import { t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";

// ---- a small store of each value here ----

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    use: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => value,
      ),
  };
}

// ---- saving ----

const SAVED_KEY = "meshnet.backups";
const saved = store(readSetting<Record<string, number>>(SAVED_KEY, {}));

/** When the radio's copy was last saved on this device, ms; null when never. */
export function useBackupSaved(radio: string | undefined): number | null {
  const all = saved.use();
  return (radio ? all[radio] : undefined) ?? null;
}

/**
 * Saves the connected radio as a copy, through the share sheet on a phone.
 * A firmware that keeps its key still gets a copy, without the key, and is
 * told so. False when nothing was saved.
 */
export async function saveBackup(): Promise<boolean> {
  const state = session.getState();
  const self = state.self;
  if (!self) return false;
  try {
    const privateKey = await session.exportKey();
    await session.refreshTuning().catch(() => undefined);
    const now = Date.now();
    const name = backupFileName(self.name, now);
    const file = writeBackup(session.getState(), privateKey, settingsSnapshot(), `Ommesh ${__APP_VERSION__}`, now);
    const how = await saveFile(name, `${JSON.stringify(file, null, 2)}\n`, "application/json", t("radio.backup.shareTitle"));
    if (how === "cancelled") return false;
    const next = { ...saved.get(), [self.key]: now };
    writeSetting(SAVED_KEY, next);
    saved.set(next);
    if (!privateKey) toast(t("radio.backup.savedKeyless"), "error");
    else if (how === "downloaded") toast(t("radio.backup.downloaded"), "", undefined, name);
    return true;
  } catch (error) {
    toast(errorText(error), "error");
    return false;
  }
}

// ---- picking ----

const picked = store<RestorePlan | null>(null);

/** The copy picked to write onto the radio, as it would go; null before one is picked. */
export function usePickedBackup(): RestorePlan | null {
  return picked.use();
}

export function dropPickedBackup(): void {
  picked.set(null);
}

/** Reads a picked file as a copy and opens the page that writes it; a file that is none is told about. */
export async function pickBackup(file: File): Promise<void> {
  const state = session.getState();
  if (!state.self) return;
  try {
    const backup = parseBackup(await file.text());
    picked.set(planRestore(backup, { self: state.self, device: state.device, contacts: state.contacts, channels: state.channels, now: Date.now() }));
    setStack("radio", [
      { kind: "radio", page: "backup" },
      { kind: "radio", page: "restore" },
    ]);
  } catch (error) {
    toast(readError(error), "error");
  }
}

/** Asks for a copy to write onto the radio: the system's file picker, then the page. */
export function chooseBackup(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.hidden = true;
  // Some web views open the picker only for an input in the page.
  document.body.append(input);
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void pickBackup(file);
  });
  input.addEventListener("cancel", () => input.remove());
  input.click();
}

function readError(error: unknown): string {
  if (error instanceof BackupFileError) {
    if (error.kind === "newer") return t("radio.backup.newer");
    if (error.kind === "field") return t("radio.backup.badField", { path: error.path });
    return t("radio.backup.notBackup");
  }
  return errorText(error);
}

// ---- writing ----

/** The copy under way: the steps it takes, and the one it is on with its count, or that the radio is being waited for. */
export type RestoreRun = { phase: "writing"; steps: RestoreStep[]; step: RestoreStep; done: number; total: number } | { phase: "back"; steps: RestoreStep[] };

const run = store<RestoreRun | null>(null);

/** How far the copy being written has got; null while none is. */
export function useRestoreRun(): RestoreRun | null {
  return run.use();
}

/**
 * Writes the chosen parts of a copy onto the radio, then waits for it to come
 * back from its reboot as the copy's node and brings in the chats and the
 * settings. "keyRefused" when the firmware takes no key; nothing was written.
 */
export async function restoreBackup(plan: RestorePlan, chosen: ReadonlySet<RestorePart>): Promise<"done" | "keyRefused" | "failed"> {
  const parts = partsAvailable(plan, chosen);
  const on = (part: RestorePart) => parts.has(part) && chosen.has(part);
  const copy = copyOf(plan, chosen);
  const steps: RestoreStep[] = [];
  if (copy.privateKey) steps.push("key");
  if (copy.settings) steps.push("settings");
  if (copy.channels) steps.push("channels");
  if (copy.contacts) steps.push("contacts");
  const pin = copy.settings?.blePin;
  if (copy.privateKey || (pin !== undefined && pin !== session.getState().device?.blePin)) steps.push("reboot");
  run.set({ phase: "writing", steps, step: steps[0] ?? "settings", done: 0, total: 1 });
  try {
    const result = await session.restoreRadio(copy, (progress) => run.set({ phase: "writing", steps, ...progress }));
    if (!result.ok) {
      run.set(null);
      return "keyRefused";
    }
    const key = copy.privateKey ? plan.file.radio.publicKey : session.getState().self?.key;
    if (result.rebooted) {
      run.set({ phase: "back", steps });
      await radioBack(key);
    }
    const state = session.getState();
    let messages = 0;
    if (on("chats") && state.self?.key === plan.file.radio.publicKey) {
      const found = planImport({ kind: "ommesh", radioKey: plan.file.radio.publicKey, body: plan.file.history, console: 0 }, { self: state.self, channels: state.channels, contacts: state.contacts, now: Date.now() });
      messages = session.importHistory(found.history).messages;
    }
    if (on("app")) {
      session.adoptLocal(plan.file.app);
      adoptSettings(movedSettings(plan.file.app.settings, slotsNow(plan, state)));
    }
    await session.flush().catch(() => undefined);
    if (copy.privateKey) noteMove(plan.file.radio.publicKey);
    run.set(null);
    picked.set(null);
    const name = session.getState().self?.name ?? plan.file.radio.name;
    const brought = t("radio.backup.doneBack", {
      list: [
        t("radio.backup.channels", { count: copy.channels ? plan.channels : 0 }),
        t("radio.backup.contacts", { count: result.contacts }),
        t("radio.backup.messages", { count: messages }),
      ].join(", "),
    });
    toast(copy.privateKey ? t("radio.backup.doneKey", { name }) : t("radio.backup.done"), "", undefined, result.full ? `${brought} ${t("radio.backup.doneFull")}` : brought);
    return "done";
  } catch (error) {
    run.set(null);
    toast(errorText(error), "error");
    return "failed";
  }
}

/** Where each channel of the copy is on the radio now, found by its key: what its chats' settings follow. */
function slotsNow(plan: RestorePlan, state: SessionState): Record<number, number> {
  const slots: Record<number, number> = {};
  for (const c of plan.file.radio.channels) {
    const now = state.channels.find((held) => held.secret === c.secret);
    if (now) slots[c.slot] = now.index;
  }
  return slots;
}

/** How long to wait for the radio back from its reboot before the chats are tried all the same. */
const BACK_MS = 90_000;

/** Waits for the link to come back from the radio's reboot, holding `key`. */
function radioBack(key: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    let rebooted = false;
    const done = () => {
      stop();
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      const state = session.getState();
      if (state.status !== "ready") rebooted = true;
      else if (rebooted && (!key || state.self?.key === key)) done();
    };
    const stop = session.subscribe(check);
    const timer = setTimeout(done, BACK_MS);
    check();
  });
}

// ---- the radio a node moved from ----

interface Move {
  at: number;
  /** The board the node went to, as its firmware names it. */
  board: string;
  /** The link it was written over, `<connector>/<device>`. */
  link: string;
}

const MOVES_KEY = "meshnet.moves";
const moves = store(readSetting<Record<string, Move>>(MOVES_KEY, {}));

function linkId(): string {
  const target = getLink().target;
  return target ? `${target.connectorId}/${target.device?.id ?? ""}` : "";
}

function noteMove(key: string): void {
  const next = { ...moves.get(), [key]: { at: Date.now(), board: session.getState().device?.manufacturer ?? "", link: linkId() } };
  writeSetting(MOVES_KEY, next);
  moves.set(next);
}

/**
 * When the connected radio holds a node's key that was since written onto
 * another radio, the date it moved: two radios with one key get in each
 * other's way on the air. Told apart by the board, or by the device over the
 * same kind of link; null otherwise.
 */
export function useMovedFrom(state: Pick<SessionState, "status" | "self" | "device">): number | null {
  const all = moves.use();
  const move = (state.self ? all[state.self.key] : undefined) ?? null;
  if (!move || state.status !== "ready") return null;
  const board = state.device?.manufacturer ?? "";
  if (move.board && board && move.board !== board) return move.at;
  const [connector] = move.link.split("/");
  const here = linkId();
  return here && move.link && here.split("/")[0] === connector && here !== move.link ? move.at : null;
}

/** This radio is the node's again, the one it moved to given away or wiped: it is no longer told about. */
export function forgetMove(key: string): void {
  const next = { ...moves.get() };
  delete next[key];
  writeSetting(MOVES_KEY, next);
  moves.set(next);
}

// ---- a radio with nothing on it ----

const SEEN_KEY = "meshnet.blankSeen";
const seen = store(readSetting<string[]>(SEEN_KEY, []));

/**
 * Whether the connected radio has nothing on it yet, no contacts, no channel
 * but Public and nothing sent from it on this device, so a copy may be what
 * it waits for; false once the reader put the offer away for it. What it has
 * heard on Public since it was switched on does not count.
 */
export function useBlankRadio(state: Pick<SessionState, "status" | "self" | "contacts" | "channels" | "messages">): boolean {
  const put = seen.use();
  if (state.status !== "ready" || !state.self || put.includes(state.self.key)) return false;
  if (state.channels.length > 1 || state.messages.some((m) => m.direction === "out")) return false;
  return !Object.values(state.contacts).some((c) => !c.unsaved);
}

export function putAwayBlank(key: string): void {
  const next = [...seen.get().filter((k) => k !== key), key];
  writeSetting(SEEN_KEY, next);
  seen.set(next);
}
