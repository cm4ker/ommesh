/**
 * A problem report: what the app and the radio are, how the radio is set up,
 * what the radio says of itself now and the log, as plain text. Anyone can
 * send it as a GitHub issue through the project's server (ommesh-preview,
 * `POST /v1/report`) without an account of their own, or copy it.
 *
 * It goes out in the open, so it leaves out what is the reader's own: the
 * radio's name, key, position and PIN, messages and channel keys. The log
 * names nodes and routes, as the air does, and a command someone asked this
 * radio to run is cut out of it, since it may hold a password.
 */
import type { LogEntry, SessionState } from "@meshnet/meshcore";
import { language } from "../i18n/index.js";
import { PREVIEW_SERVER } from "./linkFetch.js";
import { nativePlatform, shell } from "./platform.js";
import { recentStops } from "./relay.js";
import { session, storage } from "./session.js";

/** Where reports go; the same server makes link previews. */
const REPORT_URL = `${PREVIEW_SERVER}/v1/report`;

/** The app in one line: its version, where it runs and in which language. */
export function appLine(): string {
  const where = shell() === "capacitor" ? nativePlatform() : shell() === "tauri" ? "desktop" : "browser";
  return `Ommesh ${__APP_VERSION__} · ${where} · ${language()}`;
}

/** The radio as far as a report needs it, never its name, key, position or PIN. */
export function radioLines(state: Pick<SessionState, "device" | "self" | "link" | "contacts" | "channels" | "tuning" | "region" | "sharedAt" | "status">): string[] {
  const lines: string[] = [];
  const { device, self } = state;
  lines.push(`link: ${state.link ? state.link.kind : "none"}, ${state.status}${state.sharedAt !== null ? ", another app is on the radio too" : ""}`);
  if (device) {
    lines.push(`firmware: ${device.firmwareVersion} (${device.buildDate}), protocol ${device.firmwareVerCode}, ${device.manufacturer}`);
    const repeat = device.repeatEnabled === null ? "unknown" : device.repeatEnabled ? "yes" : "no";
    lines.push(`passes others' packets on: ${repeat}; route hash: ${device.pathHashMode === null ? "unknown" : `${device.pathHashMode + 1} byte(s)`}`);
    lines.push(`contacts: ${Object.values(state.contacts).filter((c) => !c.unsaved).length} of ${device.maxContacts}; channels: ${state.channels.length} of ${device.maxChannels}`);
  }
  if (self) {
    lines.push(`air: ${(self.frequencyKhz / 1000).toFixed(3)} MHz, ${self.bandwidthHz / 1000} kHz, SF${self.spreadingFactor}, CR 4/${self.codingRate}, ${self.txPower} of ${self.maxTxPower} dBm`);
  }
  if (state.tuning) lines.push(`rx delay base: ${state.tuning.rxDelayBase}; airtime factor: ${state.tuning.airtimeFactor}`);
  if (state.region) lines.push(`region: ${state.region.name === null ? "none" : "set"}`);
  return lines;
}

/** A log line with what may be private cut out. */
export function redact(text: string): string {
  return text.replace(/asked this radio to run ".*"; not run$/s, 'asked this radio to run a command; not run');
}

function stamp(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export interface ReportParts {
  app: string;
  agent: string;
  /** Minutes the clock is ahead of UTC, so the log's times can be read against others'. */
  zoneMin: number;
  radio: string[];
  /** What the radio said of itself just now; null when it was not asked or did not answer. */
  now: string | null;
  /** Why the app stopped lately, on Android. */
  stops: string[];
  log: LogEntry[];
}

/** The report as plain text, oldest log line first. */
export function reportText(parts: ReportParts): string {
  const zone = `UTC${parts.zoneMin >= 0 ? "+" : "-"}${Math.floor(Math.abs(parts.zoneMin) / 60)}${Math.abs(parts.zoneMin) % 60 ? `:${String(Math.abs(parts.zoneMin) % 60).padStart(2, "0")}` : ""}`;
  const out = [`app: ${parts.app}`, `agent: ${parts.agent}`, `times: ${zone}`, "", "radio:", ...parts.radio.map((l) => `  ${l}`)];
  if (parts.now) out.push(`  now: ${parts.now}`);
  if (parts.stops.length) out.push("", "app stopped:", ...parts.stops.map((s) => `  ${s}`));
  out.push("", "log:");
  for (const e of parts.log) out.push(`${stamp(e.at)} ${e.kind.padEnd(9)} ${redact(e.text)}`);
  return out.join("\n");
}

/** The report as it stands: the radio is asked about itself first when it is connected. */
export async function buildReport(): Promise<string> {
  let now: string | null = null;
  if (session.isReady) {
    await session.refreshTuning().catch(() => undefined);
    now = await Promise.race([session.radioState(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000))]).catch(() => null);
  }
  const stops = await recentStops().then(
    (list) => list.slice(0, 5).map((s) => `${stamp(s.at)} ${s.what}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`),
    () => [],
  );
  const state = session.getState();
  return reportText({
    app: appLine(),
    agent: navigator.userAgent,
    zoneMin: -new Date().getTimezoneOffset(),
    radio: radioLines(state),
    now,
    stops,
    log: state.log,
  });
}

/** Why a report did not go: the server's word for it, or `network` when it was not reached. */
export class ReportError extends Error {
  constructor(readonly code: "bad-request" | "origin" | "too-many" | "off" | "github" | "network") {
    super(`report: ${code}`);
    this.name = "ReportError";
  }
}

/** Sends a report as a GitHub issue; resolves with its address and number. */
export async function sendReport(description: string, report: string): Promise<{ url: string; number: number }> {
  let response: Response;
  try {
    response = await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, report, app: appLine() }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ReportError("network");
  }
  const body = (await response.json().catch(() => null)) as { url?: unknown; number?: unknown; error?: unknown } | null;
  if (response.ok && typeof body?.url === "string" && typeof body.number === "number") return { url: body.url, number: body.number };
  const code = body?.error;
  throw new ReportError(code === "bad-request" || code === "origin" || code === "too-many" || code === "off" || code === "github" ? code : "github");
}

// ---- the log kept across restarts ----
//
// A problem that comes now and then is often noticed only after the app has
// started again, and the lines that told of it would be gone. So the newest
// lines are kept beside the histories, a moment after they change and when
// the app goes out of sight, and put back when it starts.

const LOG_KEY = "log:app";
const LOG_SAVE_MS = 2_000;

function isEntry(value: unknown): value is LogEntry {
  const e = value as LogEntry;
  return typeof e === "object" && e !== null && typeof e.at === "number" && typeof e.kind === "string" && typeof e.text === "string";
}

export async function keepLog(): Promise<void> {
  try {
    const kept = await storage.loadExtra(LOG_KEY);
    if (Array.isArray(kept)) session.restoreLog(kept.filter(isEntry));
  } catch {
    // A log that cannot be read is no reason to keep the app from starting.
  }
  session.note("app", `started: ${appLine()}`);
  let saved: LogEntry[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const log = session.getState().log;
    if (log === saved) return;
    saved = log;
    void storage.saveExtra(LOG_KEY, log).catch(() => undefined);
  };
  session.subscribe(() => {
    if (!timer && session.getState().log !== saved) timer = setTimeout(save, LOG_SAVE_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  save();
}
