/**
 * The ping beside a route (components/tools/RoutePing.tsx): which way the
 * next tap goes, and the pings that go as a message. A trace a tap is kept
 * with the checks (lib/ping.ts) and a ping of the whole mesh with the
 * discoveries (lib/discovery.ts), so the map draws them as it draws those.
 *
 * The way picked holds while the node's page is open: a row of taps then
 * goes the same way, and the next time the page opens it goes along the
 * route again.
 */

import { contactConversation } from "@meshnet/meshcore";
import { useSyncExternalStore } from "react";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";
import type { PingWay } from "./pingWays.js";
import { session } from "./session.js";

/** A ping that went as a message: what came of it, and how long the acknowledgement took. */
export interface MessagePing {
  key: string;
  /** Local ms it was sent. */
  at: number;
  running: boolean;
  ok: boolean;
  ms: number | null;
  error: string | null;
  /** The try going now, and how many it may make, while it goes again on its own. */
  tryNo?: number;
  tries?: number;
}

const ways = new Map<string, PingWay>();
const messagePings = new Map<string, MessagePing>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWay(key: string): PingWay {
  return useSyncExternalStore(subscribe, () => ways.get(key) ?? "route");
}

export function setWay(key: string, way: PingWay): void {
  if ((ways.get(key) ?? "route") === way) return;
  if (way === "route") ways.delete(key);
  else ways.set(key, way);
  emit();
}

/** The node's page closed: the next time, a tap goes along the route again. */
export function forgetWay(key: string): void {
  if (ways.delete(key)) emit();
}

export function useMessagePing(key: string): MessagePing | null {
  return useSyncExternalStore(subscribe, () => messagePings.get(key) ?? null);
}

function publish(p: MessagePing): void {
  messagePings.set(p.key, p);
  emit();
}

/** The longest a message ping is waited on: its own tries again end it sooner, as they run out. */
const MESSAGE_WAIT_MS = 15 * 60_000;

/**
 * Sends "checking the link" to a person and waits for its acknowledgement:
 * the only answer a companion radio always gives, and one that comes from
 * the radio itself, so the whole way there and back is checked. It reads in
 * their chat like any message, and goes again on its own as messages do.
 */
export async function pingByMessage(key: string): Promise<void> {
  if (messagePings.get(key)?.running) return;
  const at = Date.now();
  publish({ key, at, running: true, ok: false, ms: null, error: null });
  try {
    const sent = await session.sendText(contactConversation(key), t("tools.quick.messageText"));
    const ok = await delivered(sent.id, (tryNo, tries) => publish({ key, at, running: true, ok: false, ms: null, error: null, tryNo, tries }));
    publish({ key, at, running: false, ok, ms: ok ? Date.now() - at : null, error: null });
  } catch (error) {
    publish({ key, at, running: false, ok: false, ms: null, error: errorText(error) });
  }
}

/** Resolves when the message is acknowledged, or once it has gone unanswered with no tries left; `onTry` hears each try past the first. */
function delivered(id: string, onTry: (tryNo: number, tries: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let recheck: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      stop();
      clearTimeout(timer);
      if (recheck) clearTimeout(recheck);
      resolve(ok);
    };
    const settled = (): boolean | null => {
      const m = session.getState().messages.find((x) => x.id === id);
      if (!m) return false;
      if (m.status === "delivered") return true;
      const more = m.retryPlan !== null && m.retryPlan.made < m.retryPlan.total;
      return (m.status === "failed" || m.status === "unconfirmed" || m.status === "unheard") && !more ? false : null;
    };
    let told = 1;
    const check = () => {
      const m = session.getState().messages.find((x) => x.id === id);
      if (m && m.attempt + 1 > told && !done) {
        told = m.attempt + 1;
        onTry(told, Math.max(told, m.retryPlan?.total ?? told));
      }
      const now = settled();
      if (now === true) return finish(true);
      // Gone unanswered is called a moment before the next try is planned: asked again once it has been.
      if (now === false && !recheck) recheck = setTimeout(() => {
        recheck = null;
        if (settled() === false) finish(false);
      }, 100);
    };
    const stop = session.subscribe(check);
    const timer = setTimeout(() => finish(false), MESSAGE_WAIT_MS);
    check();
  });
}
