/**
 * Connecting, and reconnecting: the piece between the connect screen and the
 * session. Keeps which connector and device are in use so a dropped link can
 * be retried without asking, and so the next launch can start where this one
 * left off.
 */

import { useSyncExternalStore } from "react";
import { session } from "./session.js";
import type { Transport } from "@meshnet/meshcore";
import {
  autoConnectWanted,
  bluetoothOff,
  connectorById,
  lastLink,
  needsPairing,
  rememberLink,
  type Connector,
  type FoundDevice,
  type ReachOptions,
  type RememberedLink,
} from "../transports/index.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";
import { onRelayUp } from "./relay.js";

export interface LinkState {
  phase: "idle" | "connecting" | "connected" | "failed";
  error: string | null;
  /** Set while a dropped link is being retried. */
  retrying: boolean;
  /** Which try this is, while a link is being retried or a picked radio tried again; 0 otherwise. */
  attempt: number;
  /** The last try failed for want of a bond, whether or not the client can make one itself. */
  unpaired: boolean;
  /** The last try failed for want of a bond, and the connector can make one with a PIN (`pairLink`). */
  pair: boolean;
  /** A dropped link waits for its next try; `reconnectNow` brings it forward. */
  waiting: boolean;
  /** The last try found Bluetooth off. A try by hand asks to turn it on, where the phone lets the app ask. */
  bluetoothOff: boolean;
  /** The radio asked for, from the first try until a disconnect or a cancel; `device` is null for a chooser. */
  target: { connectorId: string; device: FoundDevice | null } | null;
  /**
   * The link dropped rather than was left, and is being got back: its chats
   * stay on screen meanwhile. A radio asked for anew, after a disconnect, is
   * connected from the connect screen instead.
   */
  dropped: boolean;
}

let state: LinkState = {
  phase: "idle",
  error: null,
  retrying: false,
  attempt: 0,
  unpaired: false,
  pair: false,
  waiting: false,
  bluetoothOff: false,
  target: null,
  dropped: false,
};
const listeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wantedLink: { connector: Connector; device: FoundDevice | null } | null = null;
/** Bumped by every connect and disconnect: an attempt from before it is no longer wanted. */
let generation = 0;

function set(patch: Partial<LinkState>): void {
  state = { ...state, unpaired: false, pair: false, waiting: false, bluetoothOff: false, ...patch };
  for (const listener of listeners) listener();
}

export function getLink(): LinkState {
  return state;
}

export function useLink(): LinkState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** A link that neither opens nor fails within this is reported as failed rather than spun on forever. */
const OPEN_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t("connect.error.noAnswer", { what, seconds: OPEN_TIMEOUT_MS / 1000 }))), OPEN_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Opens a link for attempt `gen`. A link that opens after its wait was given
 * up, or after another radio was picked, is closed rather than left holding
 * a radio nobody reads (and, on a phone, reconnected to at the next drop).
 */
async function open(connector: Connector, device: FoundDevice | null, gen: number, options: ReachOptions): Promise<Transport | null> {
  const opening = connector.connect(device, options);
  let transport: Transport;
  try {
    transport = await withTimeout(opening, device ? device.name : connector.title);
  } catch (error) {
    void opening.then((late) => late.close(), () => undefined);
    throw error;
  }
  if (gen === generation) return transport;
  await transport.close().catch(() => undefined);
  return null;
}

/** How many times a radio picked by hand is tried before the failure is shown: a weak one often times out once. */
export const CONNECT_TRIES = 3;

export function connectWith(connector: Connector, device: FoundDevice | null): Promise<void> {
  return reach(connector, device, false);
}

/** `dropped`: this gets back a link that dropped, or the last one behind its stored chats at launch, rather than one asked for anew. */
async function reach(connector: Connector, device: FoundDevice | null, dropped: boolean): Promise<void> {
  cancelRetry();
  const gen = ++generation;
  wantedLink = { connector, device };
  // A chooser cannot be reopened without a click, and a radio that wants a PIN will not stop wanting it.
  const tries = device && connector.mode !== "picker" ? CONNECT_TRIES : 1;
  for (let attempt = 1; ; attempt++) {
    set({ phase: "connecting", error: null, retrying: false, attempt: tries > 1 ? attempt : 0, target: { connectorId: connector.id, device }, dropped });
    let usable = false;
    try {
      // Asked for by hand, or at launch: the phone may ask to turn Bluetooth on.
      const transport = await open(connector, device, gen, { mayAsk: attempt === 1 });
      if (!transport) return;
      // Connected once the link is usable; the radio's contacts and channels are read after.
      await session.connect(transport, () => {
        if (gen !== generation) return;
        usable = true;
        rememberLink({
          connectorId: connector.id,
          device: device ?? { id: "", name: transport.label, detail: null, rssi: null },
          radioName: session.getState().self?.name,
          radio: shownBy(),
        });
        set({ phase: "connected", error: null, retrying: false, attempt: 0, dropped: false });
      });
      return;
    } catch (error) {
      // Given up for another radio or a disconnect: its failure is no news. One
      // after the link was usable closed it, and is retried as a drop.
      if (gen !== generation || usable) return;
      // Bluetooth left off is not turned on by trying again, and each try would ask once more.
      const off = bluetoothOff(error);
      if (attempt < tries && !needsPairing(error) && !off) continue;
      const message = errorText(error);
      if (dropped && tries > 1 && !needsPairing(error)) {
        // A link got back behind its chats is tried for as long as it takes, as after a drop.
        set({ error: message, attempt: 0 });
        scheduleRetry(off);
        return;
      }
      set({ phase: "failed", error: message, attempt: 0, unpaired: needsPairing(error), pair: canPair(connector, device, error), bluetoothOff: off });
      throw error;
    }
  }
}

/** Who the radio said it is, for the next launch to show its chats by; the PIN stays out of the storage. */
function shownBy(): RememberedLink["radio"] {
  const { self, device } = session.getState();
  return self ? { self, device: device ? { ...device, blePin: 0 } : null } : undefined;
}

function canPair(connector: Connector, device: FoundDevice | null, error: unknown): boolean {
  return Boolean(device && connector.pair && needsPairing(error));
}

/**
 * Bonds with the radio the last try wanted, with the PIN on its screen (for
 * a phone sharing its radio, any digits: the phone asks on its own screen),
 * and connects again. Throws when the pairing fails, for the PIN prompt.
 */
export async function pairLink(pin: string): Promise<void> {
  const link = wantedLink;
  if (!link?.device || !link.connector.pair) throw new Error(t("connect.error.nothingToPair"));
  await link.connector.pair(link.device, pin);
  void reach(link.connector, link.device, state.dropped).catch(() => undefined);
}

export async function disconnect(): Promise<void> {
  cancelRetry();
  generation++;
  wantedLink = null;
  // Said at once: a connect given up on answers to nothing from here, and the screen need not wait for the radio.
  set({ phase: "idle", error: null, retrying: false, attempt: 0, target: null, dropped: false });
  await session.disconnect();
}

/**
 * Gives up the connect under way, or the failure on screen. A link that opens
 * after this is closed as it arrives (see `open`).
 */
export function cancelConnect(): Promise<void> {
  return disconnect();
}

/** Stop reconnecting during installation; restore this exact link if installation fails. */
export async function pauseForUpdate(): Promise<() => Promise<void>> {
  const previous = wantedLink;
  const resume = async () => {
    if (previous) {
      // Reconnecting loads history from disk. Never replace unsaved in-memory data with an older copy.
      await session.flush();
      await connectWith(previous.connector, previous.device);
    }
  };
  try {
    await disconnect();
  } catch (error) {
    await resume().catch(() => undefined);
    throw error;
  }
  return resume;
}

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/**
 * On a drop that was not asked for, try again with a growing pause, for as
 * long as it takes: a radio out of range or switched off comes back on its
 * own time, and the app is left running to be there when it does.
 */
session.subscribe(() => {
  const status = session.getState().status;
  if (status !== "closed" || !wantedLink || state.phase !== "connected") return;
  if (!wantedLink.device || wantedLink.connector.mode === "picker") {
    // A chooser cannot be reopened without a click.
    set({ phase: "failed", error: t("connect.error.linkDropped"), dropped: true });
    return;
  }
  scheduleRetry();
});

/** The longest pause between two tries. */
const RETRY_MAX_MS = 30_000;
/**
 * How soon a link that found Bluetooth off looks again. The look costs next to
 * nothing, and Bluetooth turned on from the phone's quick settings leaves the
 * app on screen, with nothing to bring the next try forward.
 */
const OFF_RETRY_MS = 2_000;

/** `off`: the last try found Bluetooth off, which is not counted as a try. */
function scheduleRetry(off = false): void {
  const attempt = off ? 0 : state.attempt + 1;
  const delay = off ? OFF_RETRY_MS : Math.min(RETRY_MAX_MS, 1000 * 2 ** (attempt - 1));
  const gen = generation;
  set({ phase: "connecting", retrying: true, attempt, error: null, waiting: true, dropped: true, bluetoothOff: off });
  retryTimer = setTimeout(() => void retry(gen, false), delay);
}

/** `mayAsk`: this try was asked for by hand, and may ask to turn Bluetooth on. */
async function retry(gen: number, mayAsk: boolean): Promise<void> {
  retryTimer = null;
  const link = wantedLink;
  if (!link || gen !== generation) return;
  // Still off until the try finds otherwise, or the line would blink at every look.
  set({ waiting: false, bluetoothOff: state.bluetoothOff });
  let usable = false;
  try {
    const transport = await open(link.connector, link.device, gen, { mayAsk });
    if (!transport) return;
    await session.connect(transport, () => {
      if (gen !== generation) return;
      usable = true;
      set({ phase: "connected", retrying: false, attempt: 0, error: null, dropped: false });
    });
  } catch (error) {
    if (gen !== generation || usable) return;
    const message = errorText(error);
    if (needsPairing(error)) {
      // A radio that wants a bond will not stop wanting it: ask for the PIN, or say why, instead of
      // trying again (on a phone, each try would put the system's PIN prompt up once more).
      set({ phase: "failed", error: message, retrying: false, attempt: 0, unpaired: true, pair: canPair(link.connector, link.device, error) });
      return;
    }
    set({ error: message });
    scheduleRetry(bluetoothOff(error));
  }
}

/**
 * Tries the dropped link at once: the next try, brought forward, or the link
 * that failed, again. A try already under way is left to finish. Asked for
 * by hand, it may ask to turn Bluetooth on.
 */
export function reconnectNow(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    void retry(generation, true);
  } else if (state.phase === "failed" && wantedLink) {
    void reach(wantedLink.connector, wantedLink.device, state.dropped).catch(() => undefined);
  }
}

/** The next try, brought forward by the app rather than by hand: it leaves Bluetooth as it is. */
function tryNow(): void {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  void retry(generation, false);
}

// Back on screen (the window out of the tray, a phone unlocked), the next try goes at once.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryNow();
  });
  // So it does when the phone's own link to the radio comes back by itself: the
  // try finds it up and takes it over, rather than waiting out its pause.
  onRelayUp((radio) => {
    if (wantedLink?.device?.id.toUpperCase() === radio.toUpperCase()) tryNow();
  });
}

/**
 * At launch: the last link, if it can be reached without a chooser. The
 * radio's stored chats come first, and its link is reached for behind them as
 * after a drop, rather than from the connect screen. Resolves once the chats
 * are shown, or there are none to show; the link goes on.
 */
export async function autoConnect(): Promise<void> {
  if (!autoConnectWanted()) return;
  const last = lastLink();
  if (!last) return;
  const connector = connectorById(last.connectorId);
  if (!connector) return;
  const remembered = await connector.remembered();
  const device =
    remembered.find((d) => d.id === last.device.id) ?? (connector.mode === "scan" && last.device.id ? last.device : null);
  if (!device || state.phase !== "idle") return;
  const shown = last.radio ? await session.resume(last.radio.self, last.radio.device).catch(() => false) : false;
  // A radio picked meanwhile is left to it.
  if (state.phase !== "idle") return;
  void reach(connector, device, shown).catch(() => undefined);
}
