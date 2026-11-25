/**
 * Connects `MeshSession`'s MCRS v2 binary peer-data stream to the Ommesh
 * mini-app sandbox host, background worker, uninstalled-app inbox, app
 * notification pipeline, and `coreWatch.ts` background metadata.
 */

import {
  pickText,
  type DeliveryUpdate,
  type IncomingPacket,
  type Locale,
  type MiniAppPackage,
  type NotifyOptions,
} from "@ommesh/miniapp-sdk";
import type { IncomingPeerData, MeshSession, PeerDataDelivery } from "@meshnet/meshcore";
import { language, t } from "../../i18n/index.js";
import { appNoticeAllowed, getNoticePrefs } from "../noticePrefs.js";
import { notify } from "../notify.js";
import { quietAt } from "../quiet.js";
import { findCatalogByAppId, STORE_CATALOG } from "./catalog.js";
import type { HostBridge } from "./sandbox.js";
import {
  bufferPendingPacket,
  deleteAppKv,
  findInstalledByAppId,
  getMiniAppsState,
  grantPeerToApp,
  installMiniApp,
  readAppKvAll,
  setAppActivities,
  setAppKv,
  syncCatalogApps,
  takePendingPackets,
} from "./store.js";
import { runMiniAppWorker } from "./workerHost.js";

/** Currently mounted UI iframe bridge (at most one active app on screen). */
let activeHost: { appSlug: string; appId: number; bridge: HostBridge } | null = null;
let sessionRef: MeshSession | null = null;
/** Serializes incoming packet processing so concurrent worker runs never overwrite each other's KV writes. */
let incomingChain: Promise<void> = Promise.resolve();

// Refresh built-in catalog apps synchronously on module load so the very first render uses the latest bundle.
syncCatalogApps(STORE_CATALOG);

export function registerActiveMiniApp(appSlug: string, appId: number, bridge: HostBridge): () => void {
  activeHost = { appSlug, appId, bridge };
  return () => {
    if (activeHost?.bridge === bridge) activeHost = null;
  };
}

function currentLocale(): Locale {
  return language() === "ru" ? "ru" : "en";
}

function radioKeyOf(s: MeshSession | null): string {
  return s?.getState().self?.key ?? "local";
}

function peerNameFor(s: MeshSession | null, prefix: string): string {
  const contacts = s?.getState().contacts ?? {};
  const found = Object.values(contacts).find((c) => c.prefix.toLowerCase() === prefix.toLowerCase());
  return found?.name || prefix.slice(0, 8);
}

/** Shows a mini-app notification, respecting global `apps` and per-app overrides. */
export function showMiniAppNotice(appId: number, appTitle: string, options: NotifyOptions): void {
  const prefs = getNoticePrefs();
  const level = appNoticeAllowed(prefs, appId);
  if (level === "off") return;
  const quiet = quietAt(prefs.quiet, Date.now());
  const tag = options.tag ? `app:${appId}:${options.tag}` : `app:${appId}`;
  const title = options.title ?? (options.peerPrefix ? `${peerNameFor(sessionRef, options.peerPrefix)} • ${appTitle}` : appTitle);
  void notify({
    title,
    body: options.body,
    tag,
    kind: "apps",
    ...(level === "silent" ? { silent: true } : {}),
    ...(quiet ? { silent: true, quiet: true } : {}),
  });
}

async function handleIncomingPeerData(s: MeshSession, raw: IncomingPeerData): Promise<void> {
  const packet: IncomingPacket = {
    peerPrefix: raw.peerPrefix.toLowerCase(),
    peerName: peerNameFor(s, raw.peerPrefix),
    payload: raw.payload,
    timestamp: raw.timestamp,
    snr: raw.snr,
    hops: raw.hops,
    ...(raw.mirrored ? { mirrored: true } : {}),
  };

  const installed = findInstalledByAppId(raw.appId);
  if (!installed) {
    if (raw.mirrored) return;
    bufferPendingPacket(raw.appId, packet);
    const entry = findCatalogByAppId(raw.appId);
    const loc = currentLocale();
    const appName = entry ? pickText(entry.pkg.manifest.name, loc) : `App 0x${raw.appId.toString(16)}`;
    showMiniAppNotice(raw.appId, appName, {
      body: t("apps.pendingNotice"),
      peerPrefix: packet.peerPrefix,
    });
    return;
  }

  const { manifest } = installed.pkg;
  grantPeerToApp(manifest.id, packet.peerPrefix);

  // If the app UI iframe is open right now, deliver directly into it.
  if (activeHost && activeHost.appSlug === manifest.id) {
    activeHost.bridge.sendPacket(packet);
    return;
  }

  // Otherwise run the app's headless worker to update isolated storage, activities and notifications.
  await processPacketInWorker(s, installed.pkg, packet);
}

async function processPacketInWorker(s: MeshSession, pkg: MiniAppPackage, packet: IncomingPacket): Promise<void> {
  const radioKey = radioKeyOf(s);
  const self = s.getState().self;
  const loc = currentLocale();
  const out = await runMiniAppWorker(pkg, {
    self: self ? { keyPrefix: self.prefix, name: self.name } : null,
    locale: loc,
    packet,
    storage: readAppKvAll(radioKey, pkg.manifest.id),
  });
  if (!out) return;
  if (out.storageSet) {
    for (const [k, v] of Object.entries(out.storageSet)) setAppKv(radioKey, pkg.manifest.id, k, v);
  }
  if (out.storageDelete) {
    for (const k of out.storageDelete) deleteAppKv(radioKey, pkg.manifest.id, k);
  }
  if (out.activities) setAppActivities(pkg.manifest.id, out.activities);
  if (out.notify && pkg.manifest.permissions.includes("notifications")) {
    showMiniAppNotice(pkg.manifest.appId, pickText(pkg.manifest.name, loc), out.notify);
  }
  if (out.send && pkg.manifest.permissions.includes("peerData") && pkg.manifest.appId !== 0) {
    for (const item of out.send.slice(0, 2)) {
      const contact = Object.values(s.getState().contacts).find(
        (c) => c.prefix.toLowerCase() === item.peerPrefix.toLowerCase(),
      );
      if (contact) {
        void s.sendPeerData(contact.key, pkg.manifest.appId, new Uint8Array(item.payload), { retry: item.retry ?? true }).catch(() => undefined);
      }
    }
  }
}

function handleDelivery(s: MeshSession, ev: PeerDataDelivery): void {
  if (!activeHost || activeHost.appId !== ev.appId) return;
  const contact = s.getState().contacts[ev.contactKey];
  const update: DeliveryUpdate = {
    packetId: ev.packetId,
    peerPrefix: contact?.prefix ?? ev.contactKey.slice(0, 12),
    status: ev.status,
    attempt: ev.attempt,
    ...(ev.flood !== undefined ? { flood: ev.flood } : {}),
    ...(ev.rttMs !== undefined ? { rttMs: ev.rttMs } : {}),
    ...(ev.error !== undefined ? { error: ev.error } : {}),
  };
  activeHost.bridge.sendDelivery(update);
}

/** Installs a package and replays any buffered packets that arrived before installation. */
export async function installAndReplay(pkg: MiniAppPackage, source: "catalog" | "sideload"): Promise<void> {
  installMiniApp(pkg, source);
  if (pkg.manifest.appId === 0 || !sessionRef) return;
  const pending = takePendingPackets(pkg.manifest.appId);
  for (const pkt of pending) {
    grantPeerToApp(pkg.manifest.id, pkt.peerPrefix);
    await processPacketInWorker(sessionRef, pkg, pkt);
  }
}

/** Starts forwarding `MeshSession` peer-data events into the mini-app runtime. */
export function startMiniAppsRuntime(s: MeshSession): () => void {
  syncCatalogApps(STORE_CATALOG);
  sessionRef = s;
  const stopData = s.onPeerData((pkt) => {
    incomingChain = incomingChain
      .then(() => handleIncomingPeerData(s, pkt))
      .catch((error) => console.error("mini-app incoming packet failed", error));
  });
  const stopDelivery = s.onPeerDataDelivery((ev) => handleDelivery(s, ev));
  return () => {
    stopData();
    stopDelivery();
    if (sessionRef === s) sessionRef = null;
  };
}

/** Builds `WatchConfig.installedApps` for `crates/meshcore-core/src/watch.rs`. */
export function installedAppsForCore(): Record<
  string,
  { name: string; fallback: string; opcodeMask: number; labels: Record<string, string> }
> {
  const loc = currentLocale();
  const out: Record<string, { name: string; fallback: string; opcodeMask: number; labels: Record<string, string> }> = {};
  for (const entry of Object.values(getMiniAppsState().installed)) {
    const m = entry.pkg.manifest;
    if (m.appId === 0) continue;
    const bg = m.backgroundNotices;
    const labels: Record<string, string> = {};
    if (bg) {
      for (const [k, v] of Object.entries(bg.labels)) labels[k] = pickText(v, loc);
    }
    out[String(m.appId)] = {
      name: pickText(m.name, loc),
      fallback: bg ? pickText(bg.fallback, loc) : t("apps.genericNotice"),
      opcodeMask: bg?.opcodeMask ?? 0xff,
      labels,
    };
  }
  return out;
}
