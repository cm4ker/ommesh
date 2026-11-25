/**
 * Remote mini-app catalog client (`catalog.json` + `.omapp` packages).
 *
 * Merges the offline built-in `STORE_CATALOG` with the official hosted catalog
 * (GitHub Pages for `cm4ker/ommesh-miniapps`), verifies every downloaded
 * `.omapp` against its declared SHA-256 digest before decoding, and caches the
 * latest manifest locally so the Store stays usable offline.
 */

import { useSyncExternalStore } from "react";
import {
  decodeOmapp,
  MAX_OMAPP_BYTES,
  type LocalizedText,
  type MiniAppPackage,
  type MiniAppPermission,
  type MiniAppScope,
} from "@ommesh/miniapp-sdk";
import { readSetting, writeSetting } from "../storage.js";
import { compareVersions } from "../version.js";
import { STORE_CATALOG, type CatalogEntry } from "./catalog.js";
import { installAndReplay } from "./runtime.js";
import type { InstalledMiniApp } from "./store.js";

export const DEFAULT_CATALOG_BASE_URL = "https://cm4ker.github.io/ommesh-miniapps";
const CACHE_KEY = "meshnet.miniapps.remoteCatalog";
const REFRESH_COOLDOWN_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const FILE_RE = /^[a-z0-9][a-z0-9._-]{1,80}\.omapp$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VALID_SCOPES = new Set<MiniAppScope>(["standalone", "p2p", "channel"]);
const VALID_PERMS = new Set<MiniAppPermission>(["peerData", "storage", "notifications"]);

export interface RemoteCatalogItem {
  id: string;
  appId: number;
  version: string;
  name: LocalizedText;
  description?: LocalizedText;
  author: string;
  scope: MiniAppScope;
  minProtocol?: number;
  permissions: MiniAppPermission[];
  verified: boolean;
  sizeBytes: number;
  sha256: string;
  iconSvg?: string;
  file: string;
}

export interface RemoteCatalogDocument {
  schema: 1;
  updatedAt: string;
  apps: RemoteCatalogItem[];
}

export interface StoreCatalogItem {
  id: string;
  appId: number;
  version: string;
  name: LocalizedText;
  description?: LocalizedText;
  author: string;
  scope: MiniAppScope;
  minProtocol?: number;
  permissions: MiniAppPermission[];
  verified: boolean;
  sizeBytes: number;
  iconSvg: string;
  /** Where installation pulls the package bytes from. */
  origin: "builtin" | "remote";
  builtinPkg?: MiniAppPackage;
  remoteFile?: string;
  sha256?: string;
}

export interface RemoteCatalogState {
  items: StoreCatalogItem[];
  loading: boolean;
  error: string | null;
  checkedAt: number;
  updatedAt: string | null;
  /** True once a live fetch succeeded in this session (or cache is present). */
  hasRemote: boolean;
}

const FALLBACK_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/></svg>`;

const SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];

function sha256FallbackHex(msg: Uint8Array): string {
  const len = msg.length;
  const bitHi = Math.floor(len / 0x20000000);
  const bitLo = (len << 3) >>> 0;
  const padLen = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(msg);
  buf[len] = 0x80;
  buf[padLen - 8] = (bitHi >>> 24) & 0xff;
  buf[padLen - 7] = (bitHi >>> 16) & 0xff;
  buf[padLen - 6] = (bitHi >>> 8) & 0xff;
  buf[padLen - 5] = bitHi & 0xff;
  buf[padLen - 4] = (bitLo >>> 24) & 0xff;
  buf[padLen - 3] = (bitLo >>> 16) & 0xff;
  buf[padLen - 2] = (bitLo >>> 8) & 0xff;
  buf[padLen - 1] = bitLo & 0xff;

  let H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
  let H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;
  const W = new Int32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      W[i] = (buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!, w2 = W[t - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let a = H0, b = H1, c = H2, d = H3, e = H4, f = H5, g = H6, h = H7;
    for (let r = 0; r < 64; r++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA_K[r]! + W[r]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H0 = (H0 + a) | 0; H1 = (H1 + b) | 0; H2 = (H2 + c) | 0; H3 = (H3 + d) | 0;
    H4 = (H4 + e) | 0; H5 = (H5 + f) | 0; H6 = (H6 + g) | 0; H7 = (H7 + h) | 0;
  }
  return [H0, H1, H2, H3, H4, H5, H6, H7].map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Computes lowercase hex SHA-256 of `bytes`, using WebCrypto when available and pure JS over plain HTTP. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256FallbackHex(bytes);
}

function isLocalizedText(v: unknown): v is LocalizedText {
  if (typeof v === "string") return v.trim().length > 0;
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (typeof o["en"] === "string" && o["en"].trim().length > 0) || (typeof o["ru"] === "string" && o["ru"].trim().length > 0);
}

/** Validates and sanitizes an untrusted `catalog.json` payload. Returns `null` if malformed. */
export function parseRemoteCatalog(raw: unknown): RemoteCatalogDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  if (doc["schema"] !== 1 || !Array.isArray(doc["apps"])) return null;

  const apps: RemoteCatalogItem[] = [];
  const seenIds = new Set<string>();
  const seenAppIds = new Set<number>();

  for (const item of doc["apps"]) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o["id"] === "string" ? o["id"] : "";
    const appId = typeof o["appId"] === "number" ? o["appId"] : -1;
    const version = typeof o["version"] === "string" ? o["version"].trim() : "";
    const author = typeof o["author"] === "string" ? o["author"].trim() : "";
    const scope = o["scope"] as MiniAppScope;
    const file = typeof o["file"] === "string" ? o["file"] : "";
    const sha256 = typeof o["sha256"] === "string" ? o["sha256"].toLowerCase() : "";
    const sizeBytes = typeof o["sizeBytes"] === "number" ? o["sizeBytes"] : 0;

    if (!ID_RE.test(id) || seenIds.has(id)) continue;
    if (!Number.isInteger(appId) || appId < 0 || appId > 0xffff) continue;
    if (scope === "p2p" && appId === 0) continue;
    if (scope === "standalone" && appId !== 0) continue;
    if (appId !== 0 && seenAppIds.has(appId)) continue;
    if (!version || version.length > 32 || !author) continue;
    if (!VALID_SCOPES.has(scope)) continue;
    if (!isLocalizedText(o["name"])) continue;
    if (!FILE_RE.test(file)) continue;
    if (!SHA256_RE.test(sha256)) continue;
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_OMAPP_BYTES) continue;
    if (!Array.isArray(o["permissions"]) || o["permissions"].some((p) => !VALID_PERMS.has(p as MiniAppPermission))) continue;

    const rawIcon = typeof o["iconSvg"] === "string" ? o["iconSvg"].trim() : "";
    const safeIcon = rawIcon.includes("<svg") && !/<script\b/i.test(rawIcon) ? rawIcon : undefined;
    const minProtocol = typeof o["minProtocol"] === "number" && Number.isInteger(o["minProtocol"]) ? o["minProtocol"] : undefined;

    seenIds.add(id);
    if (appId !== 0) seenAppIds.add(appId);
    apps.push({
      id,
      appId,
      version,
      name: o["name"] as LocalizedText,
      ...(isLocalizedText(o["description"]) ? { description: o["description"] as LocalizedText } : {}),
      author,
      scope,
      ...(minProtocol !== undefined ? { minProtocol } : {}),
      permissions: o["permissions"] as MiniAppPermission[],
      verified: Boolean(o["verified"]),
      sizeBytes,
      sha256,
      ...(safeIcon ? { iconSvg: safeIcon } : {}),
      file,
    });
  }

  return {
    schema: 1,
    updatedAt: typeof doc["updatedAt"] === "string" ? doc["updatedAt"] : "",
    apps,
  };
}

/** Merges offline built-in catalog entries with the latest remote catalog manifest. */
export function mergeCatalogs(builtin: CatalogEntry[], remote: RemoteCatalogDocument | null): StoreCatalogItem[] {
  const byId = new Map<string, StoreCatalogItem>();

  for (const entry of builtin) {
    const m = entry.pkg.manifest;
    byId.set(m.id, {
      id: m.id,
      appId: m.appId,
      version: m.version,
      name: m.name,
      ...(m.description !== undefined ? { description: m.description } : {}),
      author: m.author,
      scope: m.scope,
      ...(m.minProtocol !== undefined ? { minProtocol: m.minProtocol } : {}),
      permissions: m.permissions,
      verified: entry.verified,
      sizeBytes: entry.sizeBytes,
      iconSvg: entry.pkg.iconSvg,
      origin: "builtin",
      builtinPkg: entry.pkg,
    });
  }

  if (remote) {
    for (const r of remote.apps) {
      const existing = byId.get(r.id);
      if (existing && compareVersions(r.version, existing.version) <= 0) {
        // Built-in bundle is already up-to-date or newer — keep instant offline install.
        continue;
      }
      byId.set(r.id, {
        id: r.id,
        appId: r.appId,
        version: r.version,
        name: r.name,
        ...(r.description !== undefined ? { description: r.description } : {}),
        author: r.author,
        scope: r.scope,
        ...(r.minProtocol !== undefined ? { minProtocol: r.minProtocol } : {}),
        permissions: r.permissions,
        verified: r.verified,
        sizeBytes: r.sizeBytes,
        iconSvg: r.iconSvg ?? existing?.iconSvg ?? FALLBACK_ICON_SVG,
        origin: "remote",
        ...(existing?.builtinPkg ? { builtinPkg: existing.builtinPkg } : {}),
        remoteFile: r.file,
        sha256: r.sha256,
      });
    }
  }

  return Array.from(byId.values());
}

/** Returns true when `item` offers a newer version than `installed`. */
export function hasCatalogUpdate(installed: InstalledMiniApp | undefined, item: StoreCatalogItem): boolean {
  if (!installed) return false;
  return compareVersions(item.version, installed.pkg.manifest.version) > 0;
}

/** Counts how many installed mini-apps currently have a newer version in `items`. */
export function countCatalogUpdates(installed: Record<string, InstalledMiniApp>, items: StoreCatalogItem[]): number {
  let n = 0;
  for (const item of items) {
    if (hasCatalogUpdate(installed[item.id], item)) n++;
  }
  return n;
}

/** Downloads and SHA-256-verifies a `.omapp` bundle for a catalog entry. */
export async function fetchCatalogPackage(
  item: StoreCatalogItem,
  options: { baseUrl?: string; fetcher?: typeof fetch } = {},
): Promise<MiniAppPackage> {
  if (item.origin === "builtin" && item.builtinPkg) {
    return item.builtinPkg;
  }
  if (!item.remoteFile || !item.sha256 || !FILE_RE.test(item.remoteFile)) {
    if (item.builtinPkg) return item.builtinPkg;
    throw new Error("invalid remote catalog entry");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_CATALOG_BASE_URL).replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    const res = await fetcher(`${baseUrl}/${encodeURIComponent(item.remoteFile)}`, {
      cache: "no-cache",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_OMAPP_BYTES) {
      throw new Error(`unexpected package size (${buf.byteLength} B)`);
    }
    bytes = new Uint8Array(buf);
  } finally {
    clearTimeout(timer);
  }

  const actualHash = await sha256Hex(bytes);
  if (actualHash !== item.sha256.toLowerCase()) {
    throw new Error("package integrity check failed (SHA-256 mismatch)");
  }

  const pkg = decodeOmapp(bytes);
  if (pkg.manifest.id !== item.id || pkg.manifest.appId !== item.appId) {
    throw new Error("package manifest does not match catalog entry");
  }
  return pkg;
}

// ---- Reactive store state ----

function loadCachedRemote(): RemoteCatalogDocument | null {
  const raw = readSetting<unknown>(CACHE_KEY, null);
  return parseRemoteCatalog(raw);
}

let cachedRemote: RemoteCatalogDocument | null = loadCachedRemote();
let state: RemoteCatalogState = {
  items: mergeCatalogs(STORE_CATALOG, cachedRemote),
  loading: false,
  error: null,
  checkedAt: 0,
  updatedAt: cachedRemote?.updatedAt ?? null,
  hasRemote: cachedRemote !== null,
};

const listeners = new Set<() => void>();
let inFlight: Promise<boolean> | null = null;

function setState(patch: Partial<RemoteCatalogState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getStoreCatalogState(): RemoteCatalogState {
  return state;
}

export function subscribeStoreCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStoreCatalog(): RemoteCatalogState {
  return useSyncExternalStore(subscribeStoreCatalog, getStoreCatalogState);
}

export function findMergedCatalogById(id: string): StoreCatalogItem | null {
  return state.items.find((i) => i.id === id) ?? null;
}

export function findMergedCatalogByAppId(appId: number): StoreCatalogItem | null {
  if (appId === 0) return null;
  return state.items.find((i) => i.appId === appId) ?? null;
}

/**
 * Refreshes the remote catalog manifest from `baseUrl/catalog.json`.
 * Quietly keeps the built-in + cached catalog when offline.
 */
export function refreshRemoteCatalog(
  options: { force?: boolean; baseUrl?: string; fetcher?: typeof fetch } = {},
): Promise<boolean> {
  if (!options.force && state.checkedAt > 0 && Date.now() - state.checkedAt < REFRESH_COOLDOWN_MS) {
    return Promise.resolve(state.hasRemote);
  }
  if (inFlight) return inFlight;

  const baseUrl = (options.baseUrl ?? DEFAULT_CATALOG_BASE_URL).replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  setState({ loading: true, error: null });

  inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetcher(`${baseUrl}/catalog.json`, {
        cache: "no-cache",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      const parsed = parseRemoteCatalog(json);
      if (!parsed) throw new Error("invalid catalog.json schema");
      cachedRemote = parsed;
      writeSetting(CACHE_KEY, parsed);
      setState({
        items: mergeCatalogs(STORE_CATALOG, parsed),
        loading: false,
        error: null,
        checkedAt: Date.now(),
        updatedAt: parsed.updatedAt || null,
        hasRemote: true,
      });
      return true;
    } catch (err) {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      });
      return false;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Downloads (if remote), verifies SHA-256, installs, and replays any pending LoRa packets. */
export async function installFromCatalog(
  item: StoreCatalogItem,
  options: { baseUrl?: string; fetcher?: typeof fetch } = {},
): Promise<MiniAppPackage> {
  const pkg = await fetchCatalogPackage(item, options);
  await installAndReplay(pkg, "catalog");
  return pkg;
}
