/**
 * What the Nodes section knows about repeaters, rooms and sensors that the
 * session does not: which screens each kind has, which of their settings the
 * console can read and write, and how. Pure, so it is testable without a
 * radio. The console keys are the firmware's (`src/helpers/CommonCLI.cpp`).
 */

import { AclRole, AdvType, contactHops, isNodeType, type ContactRecord, type NodeLogin, type SessionState } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";

export type NodeTab = "overview" | "neighbours" | "history" | "settings" | "access" | "console";

/** Each read in the language of the moment: a getter, since the module loads before the language does. */
export const TAB_LABELS: Record<NodeTab, string> = {
  get overview() {
    return t("mesh.tab.overview");
  },
  get neighbours() {
    return t("mesh.tab.neighbours");
  },
  get history() {
    return t("mesh.tab.history");
  },
  get settings() {
    return t("mesh.tab.settings");
  },
  get access() {
    return t("mesh.tab.access");
  },
  get console() {
    return t("mesh.tab.console");
  },
};

/** Only a repeater tracks neighbours; only a sensor keeps series to summarise. */
export function nodeTabs(type: number): NodeTab[] {
  if (type === AdvType.Repeater) return ["overview", "neighbours", "settings", "access", "console"];
  if (type === AdvType.Room) return ["overview", "settings", "access", "console"];
  return ["overview", "history", "settings", "access", "console"];
}

/** A node answers these to admins only. */
export const ADMIN_TABS: ReadonlySet<NodeTab> = new Set<NodeTab>(["settings", "access", "console"]);

/** A legacy "OK" sign-in names no role; it came from firmware that let only admins in. */
export function isAdmin(login: NodeLogin | undefined): boolean {
  return !!login?.ok && (login.role === null || login.role === AclRole.Admin);
}

export function hopsLabel(contact: ContactRecord): string {
  const hops = contactHops(contact);
  return hops === null ? t("mesh.hops.none") : hops === 0 ? t("mesh.hops.direct") : t("mesh.hops.count", { count: hops });
}

/**
 * When this radio last heard the node, ms, or 0. An advert carries the sender's own clock,
 * and some run hours ahead: taken as is, such a node reads "just now" and tops every list for
 * as long as its clock is wrong. The radio stamps the contact with its own clock (`lastMod`)
 * when it stores the advert, so the advert counts no later than that.
 */
export function heardAt(contact: ContactRecord): number {
  const advert = contact.lastMod > 0 ? Math.min(contact.lastAdvert, contact.lastMod) : contact.lastAdvert;
  return Math.max(contact.lastHeardAt ?? 0, advert * 1000);
}

export function nodeKindName(type: number): string {
  return t(type === AdvType.Repeater ? "mesh.kind.repeater" : type === AdvType.Room ? "mesh.kind.room" : type === AdvType.Sensor ? "mesh.kind.sensor" : "mesh.kind.node");
}

/** The nodes in the list: every repeater, room and sensor signed in to, asked for its status, or with a password saved. */
export function managedNodes(state: SessionState, saved: readonly string[]): ContactRecord[] {
  return Object.values(state.contacts)
    .filter((c) => isNodeType(c.type) && (state.logins[c.key] !== undefined || state.statusHistory[c.key] !== undefined || saved.includes(c.key)))
    .sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));
}

/** Repeaters, rooms and sensors in the contacts that are not in the list yet. */
export function addableNodes(state: SessionState, saved: readonly string[]): ContactRecord[] {
  const managed = new Set(managedNodes(state, saved).map((c) => c.key));
  return Object.values(state.contacts)
    .filter((c) => isNodeType(c.type) && !managed.has(c.key))
    .sort((a, b) => (a.name || a.prefix).localeCompare(b.name || b.prefix));
}

/** The node's clock as last known, and how it came to be known: from the sign-in, a console reply, or our own reset. */
export interface NodeClock {
  /** Seconds the node's clock was behind ours; negative when it ran ahead. */
  drift: number;
  /** Local clock, ms. */
  at: number;
  from: "login" | "reply" | "reset";
}

/** The latest of the sign-in's clock and any read since. Null without either. */
export function nodeClock(login: NodeLogin | undefined): NodeClock | null {
  if (!login?.ok) return null;
  if (login.clock) return { drift: login.clock.drift, at: login.clock.at, from: login.clock.reset ? "reset" : "reply" };
  if (login.serverTime === null) return null;
  return { drift: Math.round(login.at / 1000 - login.serverTime), at: login.at, from: "login" };
}

// ---- settings ----

export type FieldKind = "text" | "number" | "select" | "toggle" | "textarea";

export interface SettingField {
  /** The console key, and the name the value is remembered under. */
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  hint?: string;
  /** Inclusive bounds for a number; `allowZero` lets 0 through below `min`. */
  min?: number;
  max?: number;
  allowZero?: boolean;
}

export type GroupId = "identity" | "radio" | "repeating" | "access" | "power";

export interface SettingGroup {
  id: GroupId;
  title: string;
  fields: SettingField[];
}

/**
 * A field whose label and hint are read in the language of the moment: the
 * tables below are made when the module loads, before the language is known.
 */
function makeField(label: Key, spec: Omit<SettingField, "label" | "hint">, hint?: Key): SettingField {
  const made = Object.defineProperty({ ...spec }, "label", { get: () => t(label), enumerable: true }) as SettingField;
  if (hint) Object.defineProperty(made, "hint", { get: () => t(hint), enumerable: true });
  return made;
}

/** A group whose title is read in the language of the moment. */
function makeGroup(id: GroupId, title: Key, fields: SettingField[]): SettingGroup {
  return Object.defineProperty({ id, fields }, "title", { get: () => t(title), enumerable: true }) as SettingGroup;
}

export const RADIO_FIELDS: SettingField[] = [
  makeField("mesh.settings.freq", { name: "freq", kind: "text" }),
  makeField("mesh.settings.bw", { name: "bw", kind: "select", options: ["7.8", "10.4", "15.6", "20.8", "31.25", "41.7", "62.5", "125", "250", "500"] }),
  makeField("mesh.settings.sf", { name: "sf", kind: "select", options: ["5", "6", "7", "8", "9", "10", "11", "12"] }),
  makeField("mesh.settings.cr", { name: "cr", kind: "select", options: ["5", "6", "7", "8"] }),
];

const GROUPS: Record<GroupId, SettingGroup> = {
  identity: makeGroup("identity", "mesh.settings.identity", [
    makeField("mesh.settings.name", { name: "name", kind: "text" }),
    makeField("mesh.settings.lat", { name: "lat", kind: "text" }),
    makeField("mesh.settings.lon", { name: "lon", kind: "text" }),
    makeField("mesh.settings.ownerInfo", { name: "owner.info", kind: "textarea" }, "mesh.settings.ownerInfoHint"),
  ]),
  // Frequency, bandwidth, SF and CR travel as one `radio` value; see RADIO_FIELDS.
  radio: makeGroup("radio", "mesh.settings.radio", [makeField("mesh.settings.tx", { name: "tx", kind: "number", min: -9, max: 30 })]),
  repeating: makeGroup("repeating", "mesh.settings.repeating", [
    makeField("mesh.settings.repeat", { name: "repeat", kind: "toggle" }, "mesh.settings.repeatHint"),
    makeField("mesh.settings.floodMax", { name: "flood.max", kind: "number", min: 0, max: 64 }),
    makeField("mesh.settings.advertInterval", { name: "advert.interval", kind: "number", min: 60, max: 240, allowZero: true }, "mesh.settings.advertIntervalHint"),
    makeField("mesh.settings.floodAdvertInterval", { name: "flood.advert.interval", kind: "number", min: 0, max: 168 }, "mesh.settings.floodAdvertIntervalHint"),
    makeField("mesh.settings.txdelay", { name: "txdelay", kind: "text" }),
    makeField("mesh.settings.directTxdelay", { name: "direct.txdelay", kind: "text" }),
    makeField("mesh.settings.rxdelay", { name: "rxdelay", kind: "text" }),
    makeField("mesh.settings.af", { name: "af", kind: "text" }),
  ]),
  access: makeGroup("access", "mesh.settings.guests", [
    makeField("mesh.settings.guestPassword", { name: "guest.password", kind: "text" }),
    makeField("mesh.settings.allowReadOnly", { name: "allow.read.only", kind: "toggle" }, "mesh.settings.allowReadOnlyHint"),
  ]),
  power: makeGroup("power", "mesh.settings.power", [makeField("mesh.settings.powersaving", { name: "powersaving", kind: "toggle" }, "mesh.settings.powersavingHint")]),
};

/** A sensor has no guests; a room does not repeat. */
export function settingGroups(type: number): SettingGroup[] {
  const ids: GroupId[] =
    type === AdvType.Repeater
      ? ["identity", "radio", "repeating", "access", "power"]
      : type === AdvType.Room
        ? ["identity", "radio", "access", "power"]
        : ["identity", "radio", "power"];
  return ids.map((id) => GROUPS[id]);
}

/** The names a group reads from the node: the radio group reads `radio` whole. */
export function groupReads(group: SettingGroup): string[] {
  return group.id === "radio" ? ["radio", ...group.fields.map((f) => f.name)] : group.fields.map((f) => f.name);
}

export function readCommand(name: string): string {
  return name === "powersaving" ? "powersaving" : `get ${name}`;
}

/** The node writes owner info with `|` for each line break, both ways. */
export function writeCommand(name: string, value: string): string {
  if (name === "powersaving") return `powersaving ${value}`;
  if (name === "owner.info") return `set owner.info ${value.replace(/\r?\n/g, "|")}`;
  return `set ${name} ${value}`;
}

export function displayValue(name: string, value: string): string {
  return name === "owner.info" ? value.replace(/\|/g, "\n") : value;
}

export function storedValue(name: string, value: string): string {
  return name === "owner.info" ? value.replace(/\r?\n/g, "|") : value;
}

export interface RadioValue {
  freq: string;
  bw: string;
  sf: string;
  cr: string;
}

/** `869.618,62.500,8,8`, as `get radio` answers it. */
export function parseRadio(value: string | undefined): RadioValue | null {
  if (!value) return null;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const [freq, bw, sf, cr] = parts as [string, string, string, string];
  // The node keeps the frequency as a float and prints it whole: 869.1610107 is 869.161.
  return { freq: trimNumber(freq, 3), bw: trimNumber(bw, 3), sf, cr };
}

export function formatRadio(radio: RadioValue): string {
  return `${radio.freq},${radio.bw},${radio.sf},${radio.cr}`;
}

function trimNumber(text: string, decimals: number): string {
  const n = Number(text);
  return Number.isFinite(n) ? String(Number(n.toFixed(decimals))) : text;
}

/** What is wrong with a value before it goes on the air, or null. */
export function validate(field: SettingField, value: string): string | null {
  if (field.kind === "number") {
    if (!/^-?\d+$/.test(value.trim())) return t("mesh.settings.wholeNumber");
    const n = Number(value);
    if (field.allowZero && n === 0) return null;
    if (field.min !== undefined && n < field.min) return t("mesh.settings.atLeast", { min: field.min });
    if (field.max !== undefined && n > field.max) return t("mesh.settings.atMost", { max: field.max });
  }
  if ((field.name === "lat" || field.name === "lon") && !Number.isFinite(Number(value))) return t("mesh.settings.degrees");
  if (field.name === "name" && !value.trim()) return t("mesh.settings.nameNeeded");
  if (new TextEncoder().encode(writeCommand(field.name, value)).length > 150) return t("mesh.settings.tooLong");
  return null;
}

export function validateRadio(radio: RadioValue): string | null {
  const freq = Number(radio.freq);
  if (!Number.isFinite(freq) || freq < 150 || freq > 2500) return t("mesh.settings.frequencyRange");
  return null;
}

/** What a node is, as a person reads it: a chat node is a person. */
export function kindLabel(type: number): string {
  return type === AdvType.Chat ? t("mesh.kind.person") : nodeKindName(type);
}
