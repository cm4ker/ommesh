/**
 * Taking contacts off the radio in bulk: the clean-up sheet, opened from the
 * Mesh list or the Contacts page, the nodes picked in the Mesh list, and the
 * tidy-up rule that runs by itself while the radio is connected. All go
 * through `removeNodes`, which says what it did and offers to undo it.
 */

import { useSyncExternalStore } from "react";
import type { RemovedBy } from "@meshnet/meshcore";
import { errorText } from "../i18n/errors.js";
import { t } from "../i18n/index.js";
import { hasSavedPassword } from "./secrets.js";
import { session } from "./session.js";
import { tidyDays, tidyPlan } from "./tidy.js";
import { toast } from "./toast.js";

// ---- the sheet ----

let sheetOpen = false;
const sheetListeners = new Set<() => void>();

export function openCleanUp(): void {
  sheetOpen = true;
  for (const listener of sheetListeners) listener();
}

export function closeCleanUp(): void {
  sheetOpen = false;
  for (const listener of sheetListeners) listener();
}

export function useCleanUpOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      sheetListeners.add(listener);
      return () => sheetListeners.delete(listener);
    },
    () => sheetOpen,
  );
}

// ---- removing ----

/**
 * Takes these off the radio, then says how many went and how full it is, with Undo. `rule`: the tidy-up rule did
 * it; `by`: who the Removed page says took them off, a clean-up unless they were picked in the Mesh list.
 */
export async function removeNodes(keys: string[], rule = false, by: RemovedBy = "tidy"): Promise<void> {
  if (keys.length === 0) return;
  let result: Awaited<ReturnType<typeof session.removeContacts>>;
  try {
    result = await session.removeContacts(keys, by);
  } catch (error) {
    toast(errorText(error), "error");
    return;
  }
  const { removed, error } = result;
  if (error) {
    toast(removed.length ? t("contacts.cleanUp.stoppedAfter", { count: removed.length, reason: errorText(error) }) : errorText(error), "error");
    return;
  }
  if (removed.length === 0) return;
  const max = session.getState().device?.maxContacts;
  const used = Object.values(session.getState().contacts).filter((c) => !c.unsaved).length;
  const detail = [rule ? t("contacts.cleanUp.tidyUp") : null, max ? t("contacts.cleanUp.slotsUsed", { used, max }) : null].filter(Boolean).join(" · ");
  toast(
    // The rule takes only nodes long unheard: say so.
    t(rule ? "contacts.cleanUp.removedOld" : "contacts.cleanUp.removed", { count: removed.length }),
    "",
    {
      label: t("common.undo"),
      run: async () => {
        // A node the radio never kept only left the list, and has nothing to be put back from.
        const back = removed.filter((k) => session.getState().removed[k]);
        try {
          await session.restoreContacts(back);
          toast(t("contacts.cleanUp.putBack", { count: back.length }));
        } catch (e) {
          toast(errorText(e), "error");
        }
      },
    },
    detail || undefined,
  );
}

// ---- the rule ----

let lastRule = 0;
const RULE_EVERY_MS = 24 * 3600 * 1000;

/** The tidy-up rule, if it is on for this radio: the nodes not heard for its days go, and only those. */
async function runRule(force = false): Promise<void> {
  const state = session.getState();
  if (state.status !== "ready" || !state.self || state.removing) return;
  const days = tidyDays(state.self.key);
  if (!days) return;
  if (!force && Date.now() - lastRule < RULE_EVERY_MS) return;
  lastRule = Date.now();
  const saved = Object.keys(state.contacts).filter(hasSavedPassword);
  const plan = tidyPlan(state, saved, days, Date.now());
  await removeNodes(
    plan.remove.map((c) => c.key),
    true,
  );
}

/**
 * Runs the rule a moment after the radio is connected, once a day while it
 * stays connected, and whenever the radio says it is full. Returns the stop.
 */
export function startTidyRule(): () => void {
  let ready = false;
  let full = false;
  let delay: ReturnType<typeof setTimeout> | null = null;
  const stop = session.subscribe(() => {
    const state = session.getState();
    const nowReady = state.status === "ready";
    if (nowReady && !ready) {
      lastRule = 0;
      if (delay) clearTimeout(delay);
      delay = setTimeout(() => void runRule(), 5000);
    }
    if (state.contactsFull && !full) void runRule(true);
    ready = nowReady;
    full = state.contactsFull;
  });
  const timer = setInterval(() => void runRule(), 3600 * 1000);
  return () => {
    stop();
    clearInterval(timer);
    if (delay) clearTimeout(delay);
  };
}
