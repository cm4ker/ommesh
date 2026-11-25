/**
 * Host-side state for Ommesh mini-apps: installed `.omapp` bundles, per-app
 * isolated KV storage, Peer Grants, activity summaries (for the Apps hub &
 * tab badge), and packets buffered for apps that are not installed yet.
 */

import { useSyncExternalStore } from "react";
import {
  decodeOmapp,
  encodeOmapp,
  type IncomingPacket,
  type MiniAppActivity,
  type MiniAppPackage,
} from "@ommesh/miniapp-sdk";
import { readSetting, writeSetting } from "../storage.js";
import { compareVersions } from "../version.js";

const INSTALLED_KEY = "meshnet.miniapps.installed";
const GRANTS_KEY = "meshnet.miniapps.grants";
const ACTIVITIES_KEY = "meshnet.miniapps.activities";
const KV_PREFIX = "meshnet.miniapps.kv.";
const MAX_APP_KV_BYTES = 1024 * 1024; // 1 MiB per app

export interface InstalledMiniApp {
  pkg: MiniAppPackage;
  source: "catalog" | "sideload";
  installedAt: number;
  sizeBytes: number;
}

export interface PendingAppPacket {
  appId: number;
  peerPrefix: string;
  peerName: string;
  payload: number[];
  timestamp: number;
  snr: number;
  hops: number | null;
  receivedAt: number;
}

export interface MiniAppsSnapshot {
  installed: Record<string, InstalledMiniApp>;
  /** Peer key prefixes granted to each app (`manifest.id -> prefix[]`). */
  grants: Record<string, string[]>;
  /** Current activities reported by each app (`manifest.id -> activities[]`). */
  activities: Record<string, MiniAppActivity[]>;
  /** Incoming packets for `appId`s that are not installed yet (`appId -> packets[]`). */
  pending: Record<number, PendingAppPacket[]>;
}

function loadInstalled(): Record<string, InstalledMiniApp> {
  const raw = readSetting<Record<string, InstalledMiniApp>>(INSTALLED_KEY, {});
  const out: Record<string, InstalledMiniApp> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (entry?.pkg?.format === "omapp-v1" && entry.pkg.manifest?.id === id) {
      out[id] = entry;
    }
  }
  return out;
}

let state: MiniAppsSnapshot = {
  installed: loadInstalled(),
  grants: readSetting<Record<string, string[]>>(GRANTS_KEY, {}),
  activities: readSetting<Record<string, MiniAppActivity[]>>(ACTIVITIES_KEY, {}),
  pending: {},
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getMiniAppsState(): MiniAppsSnapshot {
  return state;
}

export function subscribeMiniApps(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMiniApps(): MiniAppsSnapshot {
  return useSyncExternalStore(subscribeMiniApps, getMiniAppsState);
}

/** Total count of items needing attention across installed apps and uninstalled invites. */
export function miniAppsBadgeCount(snapshot: MiniAppsSnapshot): number {
  let count = 0;
  for (const list of Object.values(snapshot.activities)) {
    for (const item of list) if (item.needsAttention) count++;
  }
  for (const packets of Object.values(snapshot.pending)) {
    if (packets.length > 0) count++;
  }
  return count;
}

export function useMiniAppsBadge(): number {
  const snap = useMiniApps();
  return miniAppsBadgeCount(snap);
}

export function findInstalledByAppId(appId: number): InstalledMiniApp | null {
  if (appId === 0) return null;
  for (const entry of Object.values(state.installed)) {
    if (entry.pkg.manifest.appId === appId) return entry;
  }
  return null;
}

export function installMiniApp(pkg: MiniAppPackage, source: "catalog" | "sideload"): InstalledMiniApp {
  const bytes = encodeOmapp(pkg);
  const id = pkg.manifest.id;
  // Prevent two installed apps from owning the same non-zero appId.
  if (pkg.manifest.appId !== 0) {
    const conflict = findInstalledByAppId(pkg.manifest.appId);
    if (conflict && conflict.pkg.manifest.id !== id) {
      throw new Error(`appId 0x${pkg.manifest.appId.toString(16)} is already used by ${conflict.pkg.manifest.id}`);
    }
  }
  const entry: InstalledMiniApp = {
    pkg,
    source,
    installedAt: Date.now(),
    sizeBytes: bytes.length,
  };
  state = { ...state, installed: { ...state.installed, [id]: entry } };
  writeSetting(INSTALLED_KEY, state.installed);
  emit();
  return entry;
}

export function installOmappBytes(input: Uint8Array | string, source: "catalog" | "sideload"): InstalledMiniApp {
  const pkg = decodeOmapp(input);
  return installMiniApp(pkg, source);
}

/**
 * Silently updates installed built-in catalog apps when Ommesh ships a newer
 * bundle revision, preserving isolated KV storage, Peer Grants and activities.
 */
export function syncCatalogApps(catalog: { pkg: MiniAppPackage; sizeBytes: number }[]): void {
  let changed = false;
  const installed = { ...state.installed };
  for (const item of catalog) {
    const id = item.pkg.manifest.id;
    const existing = installed[id];
    if (!existing || existing.source !== "catalog") continue;
    const cmp = compareVersions(item.pkg.manifest.version, existing.pkg.manifest.version);
    // Never downgrade a newer version installed from the remote catalog.
    if (cmp > 0 || (cmp === 0 && existing.sizeBytes !== item.sizeBytes)) {
      installed[id] = {
        ...existing,
        pkg: item.pkg,
        sizeBytes: item.sizeBytes,
      };
      changed = true;
    }
  }
  if (!changed) return;
  state = { ...state, installed };
  writeSetting(INSTALLED_KEY, installed);
  emit();
}

export function uninstallMiniApp(id: string): void {
  if (!state.installed[id]) return;
  const installed = { ...state.installed };
  delete installed[id];
  const grants = { ...state.grants };
  delete grants[id];
  const activities = { ...state.activities };
  delete activities[id];
  state = { ...state, installed, grants, activities };
  writeSetting(INSTALLED_KEY, installed);
  writeSetting(GRANTS_KEY, grants);
  writeSetting(ACTIVITIES_KEY, activities);
  writeSetting(`${KV_PREFIX}${id}`, null);
  emit();
}

export function hasPeerGrant(id: string, peerPrefix: string): boolean {
  const list = state.grants[id];
  return !!list && list.includes(peerPrefix.toLowerCase());
}

export function grantPeerToApp(id: string, peerPrefix: string): void {
  const norm = peerPrefix.toLowerCase();
  const prev = state.grants[id] ?? [];
  if (prev.includes(norm)) return;
  const grants = { ...state.grants, [id]: [...prev, norm] };
  state = { ...state, grants };
  writeSetting(GRANTS_KEY, grants);
  emit();
}

export function setAppActivities(id: string, list: MiniAppActivity[]): void {
  const clean = list.slice(0, 64).map((a) => ({
    ...a,
    id: String(a.id).slice(0, 64),
    title: String(a.title).slice(0, 80),
    subtitle: String(a.subtitle).slice(0, 120),
    needsAttention: Boolean(a.needsAttention),
    updatedAt: Number.isFinite(a.updatedAt) ? a.updatedAt : Date.now(),
  }));
  const activities = { ...state.activities, [id]: clean };
  state = { ...state, activities };
  writeSetting(ACTIVITIES_KEY, activities);
  emit();
}

export function bufferPendingPacket(appId: number, packet: IncomingPacket): void {
  const existing = state.pending[appId] ?? [];
  const next: PendingAppPacket = {
    appId,
    peerPrefix: packet.peerPrefix,
    peerName: packet.peerName,
    payload: Array.from(packet.payload),
    timestamp: packet.timestamp,
    snr: packet.snr,
    hops: packet.hops,
    receivedAt: Date.now(),
  };
  const updated = [...existing, next].slice(-32);
  state = { ...state, pending: { ...state.pending, [appId]: updated } };
  emit();
}

export function takePendingPackets(appId: number): IncomingPacket[] {
  const list = state.pending[appId];
  if (!list || list.length === 0) return [];
  const pending = { ...state.pending };
  delete pending[appId];
  state = { ...state, pending };
  emit();
  return list.map((p) => ({
    peerPrefix: p.peerPrefix,
    peerName: p.peerName,
    payload: new Uint8Array(p.payload),
    timestamp: p.timestamp,
    snr: p.snr,
    hops: p.hops,
  }));
}

// ---- Isolated per-app KV storage (namespaced by radio key + app id) ----

function kvSlot(radioKey: string, appIdSlug: string): string {
  return `${KV_PREFIX}${radioKey || "local"}:${appIdSlug}`;
}

export function readAppKvAll(radioKey: string, appIdSlug: string): Record<string, unknown> {
  return readSetting<Record<string, unknown>>(kvSlot(radioKey, appIdSlug), {});
}

function writeAppKvAll(radioKey: string, appIdSlug: string, map: Record<string, unknown>): void {
  const serialized = JSON.stringify(map);
  if (serialized.length > MAX_APP_KV_BYTES) {
    throw new Error("mini-app storage quota exceeded (1 MiB)");
  }
  writeSetting(kvSlot(radioKey, appIdSlug), map);
}

export function getAppKv(radioKey: string, appIdSlug: string, key: string): unknown {
  const all = readAppKvAll(radioKey, appIdSlug);
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
}

export function setAppKv(radioKey: string, appIdSlug: string, key: string, value: unknown): void {
  const all = readAppKvAll(radioKey, appIdSlug);
  all[key] = value;
  writeAppKvAll(radioKey, appIdSlug, all);
}

export function deleteAppKv(radioKey: string, appIdSlug: string, key: string): void {
  const all = readAppKvAll(radioKey, appIdSlug);
  if (!Object.prototype.hasOwnProperty.call(all, key)) return;
  delete all[key];
  writeAppKvAll(radioKey, appIdSlug, all);
}

export function listAppKv(radioKey: string, appIdSlug: string): string[] {
  return Object.keys(readAppKvAll(radioKey, appIdSlug));
}
