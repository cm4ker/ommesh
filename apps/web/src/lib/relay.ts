/**
 * The phone's native link to the radio (`MeshRelay.java` on Android,
 * `MeshRelay.swift` on iOS), and the radio shared with a computer through it.
 *
 * On a phone the page always talks to its BLE radio through the native link:
 * the phone stops the page's scripts soon after the app leaves the screen
 * (iOS within seconds, Android in about a minute), and the link goes on
 * reading the radio for it, kept up by a foreground service on Android and by
 * the `bluetooth-central` background mode on iOS. Its radio core
 * (`crates/meshcore-core`) keeps every message for the page and announces
 * what arrives while the page sleeps, from the settings and names
 * `configureCore` hands it (`coreWatch.ts`). It runs a coverage survey too,
 * on the phone's position read natively, so the survey goes on with the
 * phone locked (`survey.ts`).
 *
 * Shared, the phone serves the radio's own Bluetooth service, so a computer
 * nearby connects to the phone as if it were the radio, and uses it through
 * the phone, in the background too. Both use the radio at once: the relay
 * takes turns between the two and keeps each a copy of every message.
 */

import { useSyncExternalStore } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { nativePlatform, shell } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";

/** One time the app, or its page's renderer, stopped: when (ms), and why, as Android says. */
export interface AppStop {
  at: number;
  what: "app" | "page";
  reason: string;
  detail: string | null;
}

interface RelayState {
  /** Shared with a computer. */
  on: boolean;
  /** A computer is connected to the phone. */
  computer: boolean;
  /** Linked to a radio for the page. */
  linked: boolean;
  /** Android: the linked radio, by the id the BLE plugin gives it. */
  radio?: string | null;
  /** Android: the linked radio answers, so the page's frames go to it at once. */
  up?: boolean;
}

/** A coverage survey as the radio core has it: its JSON (`survey.rs`), and whether it runs. */
export interface CoreSurveyAnswer {
  /** Null when the core has none, running or kept from before the app last stopped. */
  json: string | null;
  running: boolean;
}

interface MeshRelayPlugin {
  start(options: { deviceId: string; name: string; share: boolean }): Promise<RelayState>;
  /** Shares the linked radio, or stops sharing it; the link stays. */
  share(options: { on: boolean }): Promise<RelayState>;
  stop(): Promise<RelayState>;
  /** The page's notice settings and names for the radio core, and the signal file its notices ring with. */
  configure(options: { json: string; sound: string | null }): Promise<void>;
  /** The page announced this tag itself. */
  announced(options: { tag: string }): Promise<void>;
  /** Android: why the app or its page stopped lately, newest first. */
  exits(): Promise<{ stops: AppStop[] }>;
  state(): Promise<RelayState>;
  attach(): Promise<void>;
  detach(): Promise<void>;
  send(options: { data: string }): Promise<void>;
  /** Starts the survey the JSON describes in the radio core; the survey as it stands. */
  surveyStart(options: { json: string }): Promise<CoreSurveyAnswer>;
  /** Ends it; the survey as it ended, all its points with it. */
  surveyStop(): Promise<CoreSurveyAnswer>;
  survey(): Promise<CoreSurveyAnswer>;
  addListener(event: "state", listener: (state: RelayState) => void): Promise<PluginListenerHandle>;
  addListener(event: "frame", listener: (event: { data: string }) => void): Promise<PluginListenerHandle>;
  /** Each step of the survey running, with its last point. */
  addListener(event: "survey", listener: (event: { json: string }) => void): Promise<PluginListenerHandle>;
}

const WANTED_KEY = "meshnet.relay.on";

let plugin: MeshRelayPlugin | null = null;
let state: RelayState = { on: false, computer: false, linked: false };
const listeners = new Set<() => void>();

/** Whether the page reaches its BLE radio through the phone's native link: a phone's shell. */
export function relayAvailable(): boolean {
  const platform = nativePlatform();
  return shell() === "capacitor" && (platform === "ios" || platform === "android");
}

/** Whether the radio should be shared with a computer. */
export function relayWanted(): boolean {
  return relayAvailable() && readSetting<boolean>(WANTED_KEY, false);
}

export function setRelayWanted(on: boolean): void {
  writeSetting(WANTED_KEY, on);
}

const upListeners = new Set<(radio: string) => void>();

function set(next: RelayState): void {
  const cameUp = next.up === true && state.up !== true ? next.radio : null;
  state = next;
  for (const listener of listeners) listener();
  if (cameUp) for (const listener of upListeners) listener(cameUp);
}

/**
 * Android: `listener` hears the radio's id whenever the phone's link to it
 * comes up, which it does by itself once the radio is in range again or
 * Bluetooth is back on.
 */
export function onRelayUp(listener: (radio: string) => void): () => void {
  if (!relayAvailable()) return () => undefined;
  upListeners.add(listener);
  void listen().catch(() => undefined);
  return () => upListeners.delete(listener);
}

/** Resolves once the phone's link to `deviceId` comes up; not at all while `cancel` has not been called and it does not. */
export function relayComesUp(deviceId: string): { up: Promise<void>; cancel: () => void } {
  let cancel = (): void => undefined;
  const up = new Promise<void>((resolve) => {
    cancel = onRelayUp((radio) => {
      if (radio.toUpperCase() === deviceId.toUpperCase()) resolve();
    });
  });
  return { up, cancel };
}

export function useRelay(): RelayState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/**
 * Runs `use` with the plugin. Never resolve a Promise with the plugin itself:
 * the Capacitor proxy answers `then`, and the promise would hang (see notify.ts).
 */
async function withRelay<T>(use: (api: MeshRelayPlugin) => Promise<T>): Promise<T> {
  if (!plugin) {
    const { registerPlugin } = await import("@capacitor/core");
    plugin = registerPlugin<MeshRelayPlugin>("MeshRelay");
  }
  return use(plugin);
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** The page's link through the relay, while one is open. */
export interface RelayLink {
  send(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface Route {
  onFrame: (frame: Uint8Array) => void;
  /** The link was let go, or its radio went while the page had no link of its own to hear it by. */
  onStopped: (reason: string) => void;
  /** Taken over as it was, with no BLE plugin link beside it: the radio's going is heard only here. */
  held: boolean;
}

let route: Route | null = null;
let listening: Promise<unknown> | null = null;

function listen(): Promise<unknown> {
  listening ??= Promise.all([
    withRelay((api) => api.addListener("frame", (event) => route?.onFrame(fromBase64(event.data)))),
    withRelay((api) =>
      api.addListener("state", (next) => {
        set(next);
        // The link is gone, and the page's way to the radio with it.
        if (!next.linked) route?.onStopped("the phone's link to the radio was closed");
        else if (next.up === false && route?.held) route.onStopped("Bluetooth device disconnected");
      }),
    ),
  ]);
  return listening;
}

/**
 * Whether the phone's link is to `deviceId` and up: a page made anew, after
 * Android let the last one go for memory, takes it over as it is (`held`),
 * without the BLE plugin, whose first call waits for the app to be on screen.
 */
export async function relayHolds(deviceId: string): Promise<boolean> {
  if (!relayAvailable()) return false;
  const now = await withRelay((api) => api.state());
  set(now);
  return now.linked && now.up === true && now.radio?.toUpperCase() === deviceId.toUpperCase();
}

/**
 * Links to the radio the page has just connected to, shared if wanted, and
 * talks to it through the relay; `held`, takes over the link the phone already
 * has to it, as `relayHolds` found it. Closed, the link goes too unless the
 * radio is shared: the app is then free to stop in the background.
 */
export async function openRelay(deviceId: string, name: string, onFrame: Route["onFrame"], onStopped: Route["onStopped"], held = false): Promise<RelayLink> {
  await listen();
  // Not started again: that asks Android to start the link's service, which it may refuse a page in the background.
  if (!held) set(await withRelay((api) => api.start({ deviceId, name: name.replace(/^MeshCore-/, ""), share: relayWanted() })));
  const mine: Route = { onFrame, onStopped, held };
  route = mine;
  await withRelay((api) => api.attach());
  return {
    send: (frame) => withRelay((api) => api.send({ data: toBase64(frame) })),
    async close() {
      if (route !== mine) return;
      route = null;
      await withRelay((api) => api.detach()).catch(() => undefined);
      if (!state.on) await withRelay((api) => api.stop().then(set)).catch(() => undefined);
    },
  };
}

/** Whether the page talks to its radio through the phone's link now, so the radio core is there to run a survey. */
export function relayCarries(): boolean {
  return route !== null;
}

/** Hands the radio core a coverage survey to run, as the JSON `survey.rs` reads. */
export function coreSurveyStart(json: string): Promise<CoreSurveyAnswer> {
  return withRelay((api) => api.surveyStart({ json }));
}

export function coreSurveyStop(): Promise<CoreSurveyAnswer> {
  return withRelay((api) => api.surveyStop());
}

/** The survey the radio core runs, or the one it kept when the app last stopped under it; none off a phone. */
export async function coreSurvey(): Promise<CoreSurveyAnswer> {
  if (!relayAvailable()) return { json: null, running: false };
  return withRelay((api) => api.survey());
}

/** `listener` hears each step of the survey the radio core runs, until the returned function is called. */
export async function onCoreSurvey(listener: (json: string) => void): Promise<() => void> {
  const handle = await withRelay((api) => api.addListener("survey", (event) => listener(event.json)));
  return () => void handle.remove().catch(() => undefined);
}

/** Shares the linked radio with a computer, or stops, with no new connection. */
export async function setSharing(on: boolean): Promise<void> {
  set(await withRelay((api) => api.share({ on })));
}

/** What the radio core needs to announce messages while the page sleeps. */
export async function configureCore(json: string, sound: string | null): Promise<void> {
  if (!relayAvailable()) return;
  await withRelay((api) => api.configure({ json, sound }));
}

/** The page announced this itself, so the radio core's notice for it waits no more. */
export async function coreAnnounced(tag: string): Promise<void> {
  if (!relayAvailable()) return;
  await withRelay((api) => api.announced({ tag }));
}

/** Android: why the app, or its page, stopped lately; none elsewhere. */
export async function recentStops(): Promise<AppStop[]> {
  if (!relayAvailable() || nativePlatform() !== "android") return [];
  return withRelay((api) => api.exits().then((r) => r.stops ?? []));
}
