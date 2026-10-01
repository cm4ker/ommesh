/**
 * The phone app's own notification plugins, registered once each: Capacitor
 * warns and refuses when a plugin is registered twice, and both `notify.ts`
 * and `chime.ts` reach them.
 *
 * A Capacitor plugin is a Proxy that manufactures a method for every property,
 * `then` included. Never resolve a Promise with one: Promise assimilation
 * calls the nonexistent native `then` and hangs. These are handed out
 * through a callback for that reason.
 */

import { nativePlatform, shell } from "./platform.js";

/**
 * A phone's notice is words alone, under the app's icon: a picture of who
 * wrote crowds the small screen of a watch the notice is passed on to.
 */
export interface NativeNotice {
  id: number;
  tag: string;
  title: string;
  body: string;
  /** Android's channel group: direct, chats or nodes. */
  kind: string;
  /** `signal_<id>.wav`, or null for a quiet notice. */
  sound: string | null;
  /**
   * Shown without its sound this once (a burst of news rings with its first
   * notice only), on Android's channel all the same: a channel's sound is
   * fixed, and `sound` picks the channel.
   */
  silent: boolean;
}

/**
 * The iPhone's native notices (`MeshWatch.swift`): the page's own, drawn there
 * with the app's signal and under the ids of the radio core's, which announces
 * what arrives while the page sleeps (`lib/relay.ts`).
 */
export interface MeshWatchPlugin {
  /** Opens the system's notification settings for the app. */
  openSettings(): Promise<void>;
  post(options: NativeNotice): Promise<void>;
  chime(options: { signal: string }): Promise<void>;
}

/** Android's (`NoticesPlugin.java`). */
export interface NoticesPlugin {
  openSettings(): Promise<void>;
  post(options: NativeNotice): Promise<void>;
  cancel(options: { id: number }): Promise<void>;
  chime(options: { signal: string }): Promise<void>;
  /** Makes these notification channels and deletes the app's others; a `label` is a sound beside its kind's own. */
  channels(options: { wanted: NativeChannel[] }): Promise<void>;
}

/** One of Android's notification channels: a kind's, ringing with `sound` (null: quietly). */
export interface NativeChannel {
  kind: string;
  sound: string | null;
  /** The sound's name, said after the kind's in the channel's name; none for the kind's own channel. */
  label: string | null;
}

let watch: MeshWatchPlugin | null = null;
let notices: NoticesPlugin | null = null;

/** Runs `use` with the iPhone's plugin, on an iPhone only. */
export async function withWatch(use: (watch: MeshWatchPlugin) => Promise<void>): Promise<void> {
  if (shell() !== "capacitor" || nativePlatform() !== "ios") return;
  const { registerPlugin } = await import("@capacitor/core");
  watch ??= registerPlugin<MeshWatchPlugin>("MeshWatch");
  await use(watch);
}

/** Runs `use` with Android's plugin, on Android only. */
export async function withNotices(use: (notices: NoticesPlugin) => Promise<void>): Promise<void> {
  if (shell() !== "capacitor" || nativePlatform() !== "android") return;
  const { registerPlugin } = await import("@capacitor/core");
  notices ??= registerPlugin<NoticesPlugin>("Notices");
  await use(notices);
}
