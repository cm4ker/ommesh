/**
 * The community coverage layer on the map: fetched on demand from nw.ommesh.ru
 * (`/api/coverage`) when the user turns it on, kept in IndexedDB so the cells
 * still show offline, and refreshed quietly once the cached copy gets old.
 * Nothing is fetched while the layer is off.
 *
 * The endpoint carries no CORS header for third-party origins, so the phone
 * shell reads it through Capacitor's native HTTP and the desktop shell through
 * `coverage_fetch` (`coverage.rs`), while a browser tab uses `fetch`.
 */

import { useSyncExternalStore } from "react";
import { t } from "../../i18n/index.js";
import { errorText } from "../../i18n/errors.js";
import { agoPhrase } from "../format.js";
import { getMeshTool, setMeshTool } from "../meshTool.js";
import { isCapacitor, isTauri } from "../platform.js";
import { storage } from "../session.js";
import { toast } from "../toast.js";
import { parseCoverage, type CommunityCoverage } from "./community.js";
import { COMMUNITY_COVERAGE_MAP } from "./maps.js";
import { CoverageError } from "./upload.js";

const TOGGLE_KEY = "meshnet.map.coverage";
const CACHE_KEY = "coverage:ommesh";
/** Cached coverage younger than this is shown without hitting the network again on every toggle. */
const FRESH_MS = 10 * 60_000;

interface CachedCoverage {
  fetchedAt: number;
  data: CommunityCoverage;
}

export interface CoverageLayerState {
  on: boolean;
  loading: boolean;
  data: CommunityCoverage | null;
  fetchedAt: number | null;
}

function readOn(): boolean {
  try {
    return localStorage.getItem(TOGGLE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeOn(on: boolean): void {
  try {
    localStorage.setItem(TOGGLE_KEY, on ? "on" : "off");
  } catch {
    // Private window: kept for this visit only.
  }
}

let state: CoverageLayerState = { on: readOn(), loading: false, data: null, fetchedAt: null };
const listeners = new Set<() => void>();

function set(patch: Partial<CoverageLayerState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getCoverageLayer(): CoverageLayerState {
  return state;
}

export function useCoverageLayer(): CoverageLayerState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

let hydrated = false;
let hydrating: Promise<void> | null = null;

/** Loads the last saved community coverage from IndexedDB once, so the layer draws at once even offline. */
function hydrateCache(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  const pending = storage
    .loadExtra(CACHE_KEY)
    .then((raw) => {
      hydrated = true;
      if (state.data || !raw || typeof raw !== "object") return;
      const entry = raw as Partial<CachedCoverage>;
      const parsed = parseCoverage(entry.data);
      if (parsed && typeof entry.fetchedAt === "number" && Number.isFinite(entry.fetchedAt)) {
        set({ data: parsed, fetchedAt: entry.fetchedAt });
      }
    })
    .catch(() => {
      hydrated = true;
    })
    .finally(() => {
      if (hydrating === pending) hydrating = null;
    });
  hydrating = pending;
  return pending;
}

async function fetchRemote(url: string): Promise<CommunityCoverage> {
  let raw: unknown;
  if (isCapacitor()) {
    const { CapacitorHttp } = await import("@capacitor/core");
    // Read as text so Java/Swift do not allocate thousands of native JSON objects across the bridge.
    const answer = await CapacitorHttp.get({
      url,
      headers: { Accept: "application/json" },
      responseType: "text",
      connectTimeout: 15_000,
      readTimeout: 30_000,
    });
    if (answer.status < 200 || answer.status >= 300) throw new CoverageError(`HTTP ${answer.status}`);
    raw = answer.data;
  } else if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const answer = await invoke<{ status: number; body: string }>("coverage_fetch", { url });
    if (answer.status < 200 || answer.status >= 300) throw new CoverageError(`HTTP ${answer.status}`);
    raw = answer.body;
  } else {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const answer = await fetch(url, { mode: "cors", credentials: "omit", signal: abort.signal });
      if (!answer.ok) throw new CoverageError(`HTTP ${answer.status}`);
      raw = await answer.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const parsed = parseCoverage(raw);
  if (!parsed) throw new CoverageError("unexpected coverage response");
  return parsed;
}

let fetching: Promise<boolean> | null = null;

/** Fetches fresh coverage from nw.ommesh.ru and caches it in IndexedDB; returns whether the request succeeded. */
async function loadRemote(mode: "toggle" | "refresh" | "silent"): Promise<boolean> {
  if (fetching) return fetching;
  const url = COMMUNITY_COVERAGE_MAP.coverageUrl;
  if (!url) return false;
  set({ loading: true });
  const run = fetchRemote(url)
    .then((data) => {
      const fetchedAt = Date.now();
      set({ data, fetchedAt, loading: false });
      void storage.saveExtra(CACHE_KEY, { fetchedAt, data } satisfies CachedCoverage).catch(() => undefined);
      return true;
    })
    .catch((error: unknown) => {
      set({ loading: false });
      if (mode === "silent") return false;
      if (mode === "toggle") {
        if (state.data && state.fetchedAt) {
          toast(t("tools.coverage.offlineCached"), "", undefined, t("tools.coverage.updatedAgo", { time: agoPhrase(state.fetchedAt) }));
        } else if (state.on) {
          // Turning it on with neither network nor cached cells leaves nothing to see, so turn the button back off.
          writeOn(false);
          set({ on: false });
          toast(t("tools.coverage.loadFailed"), "error", undefined, errorText(error));
        }
      } else {
        toast(t("tools.coverage.loadFailed"), "error", undefined, errorText(error));
      }
      return false;
    })
    .finally(() => {
      if (fetching === run) fetching = null;
    });
  fetching = run;
  return run;
}

/** Turns the community coverage layer on or off on the map. */
export async function setCoverageOn(on: boolean): Promise<void> {
  writeOn(on);
  set({ on });
  if (!on) {
    if (getMeshTool()?.kind === "coverage") setMeshTool(null);
    return;
  }
  await hydrateCache();
  if (!state.on) return;
  const fresh = state.data !== null && state.fetchedAt !== null && Date.now() - state.fetchedAt < FRESH_MS;
  if (!fresh) await loadRemote("toggle");
}

/** Called when the map mounts or comes back into sight: shows cached cells at once and refreshes quietly if stale. */
export async function hydrateCoverageIfOn(): Promise<void> {
  if (!state.on) return;
  await hydrateCache();
  if (!state.on) return;
  const fresh = state.data !== null && state.fetchedAt !== null && Date.now() - state.fetchedAt < FRESH_MS;
  if (!fresh) void loadRemote("silent");
}

/** Refreshes the community coverage cells from nw.ommesh.ru. */
export async function refreshCoverage(interactive = true): Promise<boolean> {
  await hydrateCache();
  return loadRemote(interactive ? "refresh" : "silent");
}

/** Marks the cached coverage stale after uploading a survey to Ommesh, refreshing quietly if the layer is on. */
export function invalidateCoverage(): void {
  if (state.fetchedAt !== null) set({ fetchedAt: 0 });
  if (state.on) void loadRemote("silent");
}
