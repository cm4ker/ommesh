import type { Locale, LocalizedText, MiniAppManifest, MiniAppPackage } from "./types.js";

/** Maximum accepted `.omapp` file size in bytes (512 KiB). */
export const MAX_OMAPP_BYTES = 512 * 1024;

/** Reserved dev/sideload `appId` range (`0xFF00..0xFFFF`). */
export const DEV_APP_ID_MIN = 0xff00;
export const DEV_APP_ID_MAX = 0xffff;

/** Resolves a localized string from a manifest with sensible fallback. */
export function pickText(text: LocalizedText | undefined, locale: Locale): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[locale] ?? text.en ?? text.ru ?? Object.values(text).find((v): v is string => typeof v === "string") ?? "";
}

/** Strict Content Security Policy injected into every mini-app sandbox iframe. */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none';";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VALID_SCOPES = new Set(["standalone", "p2p", "channel"]);
const VALID_PERMISSIONS = new Set(["peerData", "storage", "notifications"]);

/** Validates a mini-app manifest and returns an error message or null when valid. */
export function validateManifest(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "manifest must be an object";
  const m = raw as Partial<MiniAppManifest>;
  if (m.schema !== 1) return "unsupported manifest schema (expected 1)";
  if (typeof m.id !== "string" || !ID_PATTERN.test(m.id)) return "invalid manifest id";
  if (typeof m.version !== "string" || m.version.trim().length === 0 || m.version.length > 32) return "invalid manifest version";
  if (typeof m.scope !== "string" || !VALID_SCOPES.has(m.scope)) return "invalid manifest scope";
  if (!Number.isInteger(m.appId) || (m.appId as number) < 0 || (m.appId as number) > 0xffff) return "appId must be 0..65535";
  if (m.scope === "p2p" && m.appId === 0) return "p2p mini-apps must declare a non-zero appId";
  if (m.scope === "standalone" && m.appId !== 0) return "standalone mini-apps must use appId 0";
  if (!pickText(m.name, "en")) return "manifest name is required";
  if (typeof m.author !== "string" || m.author.trim().length === 0) return "manifest author is required";
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => !VALID_PERMISSIONS.has(p))) return "invalid permissions list";
  return null;
}

/** Serializes a `MiniAppPackage` to `.omapp` UTF-8 JSON bytes. */
export function encodeOmapp(pkg: MiniAppPackage): Uint8Array {
  const err = validateManifest(pkg.manifest);
  if (err) throw new Error(`invalid mini-app manifest: ${err}`);
  const bytes = new TextEncoder().encode(JSON.stringify(pkg));
  if (bytes.length > MAX_OMAPP_BYTES) {
    throw new Error(`mini-app bundle is ${bytes.length} bytes; max is ${MAX_OMAPP_BYTES}`);
  }
  return bytes;
}

/** Parses and validates a `.omapp` bundle from bytes or JSON text. */
export function decodeOmapp(input: Uint8Array | string): MiniAppPackage {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.length > MAX_OMAPP_BYTES) {
    throw new Error(`mini-app bundle exceeds ${MAX_OMAPP_BYTES} bytes`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<MiniAppPackage>;
  if (!parsed || parsed.format !== "omapp-v1") {
    throw new Error("unsupported .omapp package format");
  }
  const err = validateManifest(parsed.manifest);
  if (err) throw new Error(`invalid manifest: ${err}`);
  if (typeof parsed.html !== "string" || parsed.html.trim().length === 0) {
    throw new Error("mini-app package has no html entry");
  }
  if (typeof parsed.iconSvg !== "string" || !parsed.iconSvg.includes("<svg")) {
    throw new Error("mini-app package has no valid iconSvg");
  }
  if (parsed.workerJs !== undefined && typeof parsed.workerJs !== "string") {
    throw new Error("workerJs must be a string");
  }
  return parsed as MiniAppPackage;
}

/** Whether an `appId` lies in the developer sideloading range (`0xFF00..0xFFFF`). */
export function isDevAppId(appId: number): boolean {
  return appId >= DEV_APP_ID_MIN && appId <= DEV_APP_ID_MAX;
}
