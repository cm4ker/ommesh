/**
 * A copy of a radio in one file, `ommesh-backup`: what moving to another
 * radio takes. It holds the radio's key as the key file does, its settings
 * and channels, a whole history file with the contacts and messages, and what
 * this app keeps for the radio beside them. Written onto another radio, it
 * makes that one the same node, with the same chats (`plan.ts`, `run.ts`).
 *
 * Unlike a history file it is not to be passed on: it carries the private
 * key. Its layout is in docs/backup-format.md.
 */

import { isFault, fromDigits } from "../keyFile.js";
import { HistoryFileError, historyFileName, readHistory, writeHistory, type HistoryFile } from "../history/format.js";
import { toHex, type OtherParams, type RadioSettings, type RoutePolicy, type RoutingSettings, type SessionState } from "@meshnet/meshcore";

export const BACKUP_FORMAT = "ommesh-backup";
export const BACKUP_VERSION = 1;

export interface BackupChannel {
  slot: number;
  name: string;
  secret: string;
}

export interface BackupKey {
  name: string;
  publicKey: string;
  privateKey: string;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  saved: string;
  by: string;
  /** Null when the radio's firmware does not give its key out: such a copy makes another radio a new node. */
  key: BackupKey | null;
  radio: {
    name: string;
    publicKey: string;
    settings: RadioSettings;
    channels: BackupChannel[];
  };
  history: HistoryFile;
  app: BackupApp;
}

export interface BackupApp {
  /** This app's settings by their names between two apps sharing a radio (`sharedSettings.ts`), which say how to take each. */
  settings: Record<string, unknown>;
  routing?: RoutingSettings;
  channelRegions?: Record<string, string>;
}

type Source = Pick<SessionState, "self" | "device" | "tuning" | "autoAdd" | "region" | "channels" | "contacts" | "removed" | "messages" | "routing" | "channelRegions">;

/** The connected radio as a copy; `privateKey` null when the firmware kept it. */
export function writeBackup(state: Source, privateKey: Uint8Array | null, settings: Record<string, unknown>, by: string, now: number): BackupFile {
  const { self, device } = state;
  if (!self) throw new Error("no radio");
  const radio: RadioSettings = {
    radio: {
      frequencyKhz: self.frequencyKhz,
      bandwidthHz: self.bandwidthHz,
      spreadingFactor: self.spreadingFactor,
      codingRate: self.codingRate,
      ...(device?.repeatEnabled === null || device?.repeatEnabled === undefined ? {} : { repeat: device.repeatEnabled }),
    },
    txPower: self.txPower,
    location: { lat: self.lat, lon: self.lon },
    other: {
      manualAddContacts: self.manualAddContacts,
      telemetryModeBase: self.telemetryModeBase,
      telemetryModeLocation: self.telemetryModeLocation,
      telemetryModeEnvironment: self.telemetryModeEnvironment,
      advertLocPolicy: self.advertLocPolicy,
      multiAcks: self.multiAcks,
    },
  };
  // As read, the tuning is the radio's whole answer: only its two values go.
  if (state.tuning) radio.tuning = { rxDelayBase: state.tuning.rxDelayBase, airtimeFactor: state.tuning.airtimeFactor };
  if (state.autoAdd) radio.autoAdd = { config: state.autoAdd.config, maxHops: state.autoAdd.maxHops };
  if (device?.pathHashMode !== null && device?.pathHashMode !== undefined) radio.pathHashMode = device.pathHashMode;
  if (state.region) radio.region = state.region.name;
  if (device) radio.blePin = device.blePin;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    saved: new Date(now).toISOString(),
    by,
    key: privateKey ? { name: self.name, publicKey: self.key, privateKey: toHex(privateKey) } : null,
    radio: { name: self.name, publicKey: self.key, settings: radio, channels: state.channels.map((c) => ({ slot: c.index, name: c.name, secret: c.secret })) },
    history: writeHistory(state, by, now),
    app: { settings, routing: state.routing, channelRegions: state.channelRegions },
  };
}

/** A name for the file that says whose copy it is and when it was saved. */
export function backupFileName(radioName: string, now: number): string {
  return historyFileName(radioName, now).replace(/^ommesh-/, "ommesh-backup-");
}

/** Why a file could not be read as a copy: not one at all, one from a newer app, or one with a field wrong at `path`. */
export class BackupFileError extends Error {
  constructor(
    readonly kind: "notBackup" | "newer" | "field",
    readonly path = "",
  ) {
    super(kind === "field" ? `the copy is wrong at ${path}` : kind === "newer" ? "the copy is of a newer version" : "not a copy of a radio");
  }
}

/** A copy read and checked; keys and secrets come back lower-case. */
export function parseBackup(text: string): BackupFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackupFileError("notBackup");
  }
  if (!isObject(json) || json.format !== BACKUP_FORMAT) throw new BackupFileError("notBackup");
  const version = json.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new BackupFileError("field", "version");
  if (version > BACKUP_VERSION) throw new BackupFileError("newer");
  const radio = object(json.radio, "radio");
  const publicKey = hex(radio.publicKey, "radio.publicKey", KEY);
  let history: HistoryFile;
  try {
    history = readHistory(json.history);
  } catch (error) {
    if (!(error instanceof HistoryFileError)) throw error;
    if (error.kind === "newer") throw new BackupFileError("newer");
    throw new BackupFileError("field", error.kind === "field" ? `history.${error.path}` : "history");
  }
  if (history.radio.key !== publicKey) throw new BackupFileError("field", "history.radio.key");
  const app = json.app === undefined ? {} : object(json.app, "app");
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version,
    saved: time(json.saved, "saved"),
    by: str(json.by, "by"),
    key: json.key === null || json.key === undefined ? null : keyOf(json.key, publicKey),
    radio: {
      name: str(radio.name, "radio.name"),
      publicKey,
      settings: settingsOf(object(radio.settings, "radio.settings")),
      channels: list(radio.channels, "radio.channels", channelOf),
    },
    history,
    app: { settings: app.settings === undefined ? {} : object(app.settings, "app.settings") },
  };
  if (app.routing !== undefined) file.app.routing = routingOf(app.routing, "app.routing");
  if (app.channelRegions !== undefined) file.app.channelRegions = record(app.channelRegions, "app.channelRegions", str);
  return file;
}

type Json = Record<string, unknown>;

const KEY = /^[0-9a-f]{64}$/;
const SECRET = /^[0-9a-f]{32}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The key, which must be the radio's: a copy whose key and radio differ was put together by hand. */
function keyOf(value: unknown, publicKey: string): BackupKey {
  const o = object(value, "key");
  const found = fromDigits(str(o.privateKey, "key.privateKey").toLowerCase(), null, null);
  if (isFault(found) || found.publicKey !== publicKey) throw new BackupFileError("field", "key.privateKey");
  return { name: str(o.name, "key.name"), publicKey, privateKey: str(o.privateKey, "key.privateKey").toLowerCase() };
}

function settingsOf(o: Json): RadioSettings {
  const out: RadioSettings = {};
  const at = (key: string) => `radio.settings.${key}`;
  if (o.radio !== undefined) {
    const r = object(o.radio, at("radio"));
    out.radio = {
      frequencyKhz: whole(r.frequencyKhz, at("radio.frequencyKhz"), 100_000, 3_000_000),
      bandwidthHz: whole(r.bandwidthHz, at("radio.bandwidthHz"), 1_000, 1_000_000),
      spreadingFactor: whole(r.spreadingFactor, at("radio.spreadingFactor"), 5, 12),
      codingRate: whole(r.codingRate, at("radio.codingRate"), 5, 8),
    };
    if (r.repeat !== undefined) out.radio.repeat = bool(r.repeat, at("radio.repeat"));
  }
  if (o.txPower !== undefined) out.txPower = whole(o.txPower, at("txPower"), -9, 40);
  if (o.location !== undefined) {
    const l = object(o.location, at("location"));
    out.location = { lat: between(l.lat, at("location.lat"), -90, 90), lon: between(l.lon, at("location.lon"), -180, 180) };
  }
  if (o.other !== undefined) {
    const p = object(o.other, at("other"));
    const byte = (key: keyof OtherParams) => whole(p[key], at(`other.${key}`), 0, 255);
    out.other = {
      manualAddContacts: byte("manualAddContacts"),
      telemetryModeBase: byte("telemetryModeBase"),
      telemetryModeLocation: byte("telemetryModeLocation"),
      telemetryModeEnvironment: byte("telemetryModeEnvironment"),
      advertLocPolicy: byte("advertLocPolicy"),
      multiAcks: byte("multiAcks"),
    };
  }
  if (o.tuning !== undefined) {
    const t = object(o.tuning, at("tuning"));
    out.tuning = { rxDelayBase: between(t.rxDelayBase, at("tuning.rxDelayBase"), 0, 1000), airtimeFactor: between(t.airtimeFactor, at("tuning.airtimeFactor"), 0, 1000) };
  }
  if (o.autoAdd !== undefined) {
    const a = object(o.autoAdd, at("autoAdd"));
    out.autoAdd = { config: whole(a.config, at("autoAdd.config"), 0, 255), maxHops: whole(a.maxHops, at("autoAdd.maxHops"), 0, 255) };
  }
  if (o.pathHashMode !== undefined) out.pathHashMode = whole(o.pathHashMode, at("pathHashMode"), 0, 2);
  if (o.region !== undefined) out.region = o.region === null ? null : str(o.region, at("region"));
  if (o.blePin !== undefined) out.blePin = whole(o.blePin, at("blePin"), 0, 999_999);
  return out;
}

function channelOf(value: unknown, path: string): BackupChannel {
  const o = object(value, path);
  return { slot: whole(o.slot, `${path}.slot`, 0, 255), name: str(o.name, `${path}.name`), secret: hex(o.secret, `${path}.secret`, SECRET) };
}

function routingOf(value: unknown, path: string): RoutingSettings {
  const o = object(value, path);
  const minutes = (v: unknown, p: string): number | null => (v === null ? null : whole(v, p, 0, 10_000_000));
  return {
    resetAfterMin: minutes(o.resetAfterMin ?? null, `${path}.resetAfterMin`),
    contacts: record(o.contacts ?? {}, `${path}.contacts`, (v, p) => {
      const r = object(v, p);
      const policy: RoutePolicy = {};
      if (r.flood !== undefined) policy.flood = bool(r.flood, `${p}.flood`);
      if (r.resetAfterMin !== undefined) policy.resetAfterMin = minutes(r.resetAfterMin, `${p}.resetAfterMin`);
      if (r.manual !== undefined) policy.manual = str(r.manual, `${p}.manual`);
      return policy;
    }),
  };
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Json {
  if (!isObject(value)) throw new BackupFileError("field", path);
  return value;
}

function record<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): Record<string, T> {
  const o = object(value, path);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, item(v, `${path}.${k}`)]));
}

function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BackupFileError("field", path);
  return value.map((v, i) => item(v, `${path}[${i}]`));
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new BackupFileError("field", path);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new BackupFileError("field", path);
  return value;
}

function hex(value: unknown, path: string, shape: RegExp): string {
  const s = typeof value === "string" ? value.toLowerCase() : null;
  if (s === null || !shape.test(s)) throw new BackupFileError("field", path);
  return s;
}

function time(value: unknown, path: string): string {
  if (typeof value !== "string" || !TIME.test(value) || Number.isNaN(Date.parse(value))) throw new BackupFileError("field", path);
  return value;
}

function between(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new BackupFileError("field", path);
  return value;
}

function whole(value: unknown, path: string, min: number, max: number): number {
  const n = between(value, path, min, max);
  if (!Number.isInteger(n)) throw new BackupFileError("field", path);
  return n;
}
