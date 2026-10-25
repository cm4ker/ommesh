/**
 * Finding a setting by name, as iPhone Settings does: the field behind the
 * magnifier over the Settings list, and the Ctrl+K palette. A setting is
 * found by its own name, by words people call it by (radio.search.words),
 * and by the page and group it sits in. A setting the radio or the app does
 * not offer is not found. Opening one puts its page up and lights the row.
 */

import { regionSupport, type DeviceInfo } from "@meshnet/meshcore";
import { t, type Key } from "../i18n/index.js";
import { fold } from "./messageSearch.js";
import { setStack, type RadioPage } from "./nav.js";

/** What decides which settings there are to find. */
export interface SettingContext {
  device: DeviceInfo | null;
  /** The radio has Wi-Fi (MeshCore 1.18 built with it). */
  wifi: boolean;
  /** The radio runs console lines of its own (protocol 14, or Smart UI). */
  console: boolean;
  /** This phone can share its radio with a computer, and is on Bluetooth to it. */
  share: boolean;
  /** The settings can be kept alike with another app: this phone shares its radio, or this computer reaches one through a phone. */
  sharedSettings: boolean;
  /** Another copy of the app can be opened (the desktop). */
  another: boolean;
  /** The highest transmit power the radio takes, for the label that names it. */
  maxTxPower: number | null;
}

export interface Setting {
  page: RadioPage;
  /** The row's label as its page writes it; none for the page as a whole, or for a group (`group` then is the target). */
  label?: Key;
  /** The group it sits under, for the crumb; the setting itself when there is no label. */
  group?: Key;
  /** Words it may be looked for by besides its name, space between them. */
  words?: Key;
  when?: (ctx: SettingContext) => boolean;
}

/** The pages there are to find, with the page each opens from. */
const PAGES: Partial<Record<RadioPage, { title: Key; parent?: RadioPage; when?: (ctx: SettingContext) => boolean }>> = {
  name: { title: "radio.titles.name" },
  frequency: { title: "radio.titles.frequency" },
  readings: { title: "radio.titles.readings" },
  contacts: { title: "radio.titles.contacts" },
  removed: { title: "radio.titles.removed", parent: "contacts" },
  privacy: { title: "radio.titles.privacy" },
  trusted: { title: "radio.titles.trusted", parent: "privacy" },
  remote: { title: "radio.titles.remote", parent: "privacy", when: (c) => protocol(c) >= 14 },
  advanced: { title: "radio.titles.advanced" },
  console: { title: "radio.titles.console", parent: "advanced", when: (c) => c.console },
  key: { title: "radio.titles.key", parent: "backup" },
  connection: { title: "radio.titles.connection" },
  pin: { title: "radio.titles.pin", parent: "connection", when: (c) => c.device !== null },
  wifi: { title: "radio.titles.wifi", parent: "connection", when: (c) => c.wifi },
  notifications: { title: "radio.titles.notifications" },
  quiet: { title: "radio.titles.quiet", parent: "notifications" },
  sound: { title: "radio.titles.sound", parent: "notifications" },
  messages: { title: "radio.titles.messages" },
  backup: { title: "radio.titles.backup" },
  history: { title: "radio.titles.history", parent: "backup" },
  appearance: { title: "radio.titles.appearance" },
  background: { title: "radio.titles.background", parent: "appearance" },
  air: { title: "radio.titles.air" },
  log: { title: "radio.titles.log" },
  power: { title: "radio.titles.power" },
  about: { title: "radio.titles.about" },
  news: { title: "radio.titles.news", parent: "about" },
  people: { title: "radio.titles.people", parent: "about" },
  report: { title: "radio.titles.report", parent: "about" },
};

function protocol(ctx: SettingContext): number {
  return ctx.device?.firmwareVerCode ?? 0;
}

/** Every setting there is to find, page by page in the order Settings lists them. */
export const SETTINGS: readonly Setting[] = [
  { page: "name", words: "radio.search.words.name" },
  { page: "name", label: "radio.name.name", words: "radio.search.words.name" },

  { page: "frequency", words: "radio.search.words.frequency" },
  { page: "frequency", group: "radio.frequency.preset", words: "radio.search.words.preset" },
  { page: "frequency", label: "radio.frequency.frequency", group: "radio.frequency.values", words: "radio.search.words.frequency" },
  { page: "frequency", label: "radio.frequency.bandwidth", group: "radio.frequency.values", words: "radio.search.words.bandwidth" },
  { page: "frequency", label: "radio.frequency.spreadingFactor", group: "radio.frequency.values", words: "radio.search.words.spreadingFactor" },
  { page: "frequency", label: "radio.frequency.codingRate", group: "radio.frequency.values", words: "radio.search.words.codingRate" },
  { page: "frequency", label: "radio.frequency.txPower", group: "radio.frequency.values", words: "radio.search.words.txPower" },
  { page: "frequency", label: "radio.frequency.repeat", group: "radio.frequency.network", words: "radio.search.words.repeat", when: (c) => c.device?.repeatEnabled != null },
  { page: "frequency", label: "radio.frequency.hash", group: "radio.frequency.network", words: "radio.search.words.hash", when: (c) => c.device?.pathHashMode != null },
  { page: "frequency", label: "radio.region.title", group: "radio.frequency.network", words: "radio.search.words.region", when: (c) => regionSupport(c.device).radio },

  { page: "readings", words: "radio.search.words.readings" },

  { page: "contacts", words: "radio.search.words.contacts" },
  { page: "contacts", label: "contacts.newNodes.keep", group: "contacts.newNodes.title", words: "radio.search.words.autoAdd" },
  { page: "contacts", label: "contacts.newNodes.howFar", group: "contacts.newNodes.title" },
  { page: "contacts", label: "contacts.newNodes.whenFull", group: "contacts.newNodes.title" },
  { page: "contacts", label: "contacts.tidy.removeAfter", group: "contacts.tidy.title", words: "radio.search.words.tidy" },
  { page: "contacts", label: "contacts.memory.cleanUp", group: "contacts.memory.title", words: "radio.search.words.tidy" },
  { page: "removed" },

  { page: "privacy" },
  { page: "privacy", label: "radio.position.follow", group: "radio.privacy.location", words: "radio.search.words.place" },
  { page: "privacy", label: "radio.position.latitude", group: "radio.privacy.location", words: "radio.search.words.place" },
  { page: "privacy", label: "radio.position.longitude", group: "radio.privacy.location", words: "radio.search.words.place" },
  { page: "privacy", label: "radio.privacy.share", group: "radio.privacy.location", words: "radio.search.words.place" },
  { page: "privacy", label: "radio.privacy.readings", group: "radio.privacy.onRequest", words: "radio.search.words.telemetry" },
  { page: "privacy", label: "radio.privacy.sensors", group: "radio.privacy.onRequest", words: "radio.search.words.telemetry" },
  { page: "trusted" },
  { page: "remote", words: "radio.search.words.remote" },

  { page: "advanced" },
  { page: "console", words: "radio.search.words.console" },
  { page: "advanced", label: "radio.advanced.firmware", group: "radio.advanced.device", words: "radio.search.words.firmware", when: (c) => c.device !== null },
  { page: "advanced", label: "radio.advanced.board", group: "radio.advanced.device", when: (c) => c.device !== null },
  { page: "advanced", label: "radio.advanced.capacity", group: "radio.advanced.device", when: (c) => c.device !== null },
  { page: "advanced", label: "radio.advanced.publicKey", group: "radio.advanced.device" },
  { page: "backup", label: "radio.key.save", group: "radio.backup.part", words: "radio.search.words.key" },
  { page: "key", words: "radio.search.words.key" },
  { page: "advanced", label: "radio.advanced.setClock", group: "radio.advanced.clock", words: "radio.search.words.clock" },

  { page: "notifications", words: "radio.search.words.notifications" },
  { page: "quiet", words: "radio.search.words.quiet" },
  { page: "quiet", label: "radio.quiet.nightly", group: "radio.quiet.schedule", words: "radio.search.words.quiet" },
  { page: "quiet", label: "radio.quiet.favourites", group: "radio.quiet.through" },
  { page: "notifications", label: "radio.notifications.direct", group: "radio.notifications.messages", words: "radio.search.words.notifications" },
  { page: "notifications", label: "radio.notifications.chats", group: "radio.notifications.messages", words: "radio.search.words.notifications" },
  { page: "notifications", label: "radio.notifications.nodes", group: "radio.notifications.mesh", words: "radio.search.words.notifications" },
  { page: "notifications", label: "radio.notifications.shownBy", group: "radio.notifications.popups" },
  { page: "sound", words: "radio.search.words.sound" },

  { page: "messages" },
  { page: "messages", label: "radio.messages.openAtUnread", words: "radio.search.words.unread" },
  { page: "messages", label: "radio.messages.lookalikes", words: "radio.search.words.lookalikes" },
  { page: "messages", label: "radio.messages.readCyrillic", words: "radio.search.words.readCyrillic" },
  { page: "messages", label: "radio.messages.sendTries", words: "radio.search.words.sendTries" },
  { page: "messages", label: "radio.messages.forgetRoutes", words: "radio.search.words.routes" },
  { page: "messages", group: "radio.messages.previews", words: "radio.search.words.previews" },

  { page: "backup", words: "radio.search.words.backup" },
  { page: "backup", label: "radio.backup.save", words: "radio.search.words.backup" },
  { page: "backup", label: "radio.backup.restore", words: "radio.search.words.backup" },
  { page: "history", words: "radio.search.words.history" },
  { page: "history", label: "radio.history.save", words: "radio.search.words.history" },
  { page: "history", label: "radio.history.bringIn", words: "radio.search.words.history" },

  { page: "appearance" },
  { page: "appearance", label: "common.language", words: "radio.search.words.language" },
  { page: "appearance", group: "radio.appearance.theme", words: "radio.search.words.theme" },
  { page: "appearance", group: "radio.appearance.textSize", words: "radio.search.words.textSize" },
  { page: "appearance", label: "radio.appearance.largeEmoji", words: "radio.search.words.emoji" },
  { page: "background", words: "radio.search.words.background" },

  { page: "connection", words: "radio.search.words.connection" },
  { page: "connection", label: "radio.connection.reconnectAtLaunch", words: "radio.search.words.autoConnect" },
  { page: "pin", words: "radio.search.words.pin" },
  { page: "pin", label: "radio.pin.random", group: "radio.pin.group", words: "radio.search.words.pin" },
  { page: "pin", label: "radio.pin.own", group: "radio.pin.group", words: "radio.search.words.pin" },
  { page: "wifi", words: "radio.search.words.wifi" },
  { page: "wifi", label: "radio.wifi.password", group: "radio.wifi.network", words: "radio.search.words.wifi" },
  { page: "wifi", label: "radio.wifi.address", group: "radio.wifi.now", words: "radio.search.words.wifi" },
  { page: "connection", label: "radio.connection.share", words: "radio.search.words.share", when: (c) => c.share },
  { page: "connection", label: "radio.connection.sharedSettings", words: "radio.search.words.sharedSettings", when: (c) => c.sharedSettings },
  { page: "connection", label: "radio.connection.another", when: (c) => c.another },
  { page: "connection", label: "radio.connection.disconnect" },

  { page: "air", words: "radio.search.words.air" },
  { page: "log", words: "radio.search.words.log" },
  { page: "power" },
  { page: "power", label: "radio.power.reboot", words: "radio.search.words.reboot" },
  { page: "power", label: "radio.power.off", words: "radio.search.words.off", when: (c) => protocol(c) >= 14 },
  { page: "power", label: "radio.power.reset", words: "radio.search.words.reset" },
  { page: "power", label: "radio.power.forget", words: "radio.search.words.forget" },
  { page: "about" },
  { page: "news", words: "radio.search.words.news" },
  { page: "people" },
  { page: "report", words: "radio.search.words.report" },
];

/** A setting's name as its row shows it, or its group's, or its page's title. */
export function settingName(s: Setting, ctx: SettingContext): string {
  if (s.label === "radio.frequency.txPower") return t(s.label, { max: ctx.maxTxPower ?? 22 });
  if (s.label) return t(s.label);
  if (s.group) return t(s.group);
  return t(PAGES[s.page]!.title);
}

/** Where it is: the pages above it and the group it sits in, "Connection › Bluetooth › PIN". */
export function settingPlace(s: Setting): string {
  const meta = PAGES[s.page]!;
  const above = meta.parent ? t(PAGES[meta.parent]!.title) : null;
  const page = s.label || s.group ? t(meta.title) : null;
  const group = s.label && s.group ? t(s.group) : null;
  return [above, page, group].filter((x): x is string => !!x).join(" › ");
}

function offered(s: Setting, ctx: SettingContext): boolean {
  const meta = PAGES[s.page];
  if (!meta) return false;
  if (meta.when && !meta.when(ctx)) return false;
  const parent = meta.parent ? PAGES[meta.parent] : undefined;
  if (parent?.when && !parent.when(ctx)) return false;
  return !s.when || s.when(ctx);
}

const wordsOf = (text: string) => text.split(/[\s,·()]+/).filter(Boolean);

/** How well a setting answers the query; 0 when not at all. Its own name first, then words for it, then where it sits. */
function rank(s: Setting, q: string, ctx: SettingContext): number {
  const name = fold(settingName(s, ctx));
  if (name.startsWith(q)) return 100;
  if (wordsOf(name).some((w) => w.startsWith(q))) return 80;
  if (name.includes(q)) return 60;
  const more = s.words ? fold(t(s.words)) : "";
  if (wordsOf(more).some((w) => w.startsWith(q))) return 45;
  if (more.includes(q)) return 35;
  if (fold(settingPlace(s)).includes(q)) return 20;
  return 0;
}

/** The settings the query finds, best first; the page itself before its rows when they rank alike. */
export function findSettings(query: string, ctx: SettingContext): Setting[] {
  const q = fold(query.trim());
  if (!q) return [];
  return SETTINGS.map((s, order) => ({ s, order, score: offered(s, ctx) ? rank(s, q, ctx) : 0 }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((r) => r.s);
}

/** The rows the palette lists: each setting that is not a page. */
export function settingRows(ctx: SettingContext): Setting[] {
  return SETTINGS.filter((s) => (s.label || s.group) && offered(s, ctx));
}

// ---- the field's state, kept here so it outlives the list while a page is up on a phone ----

export interface SettingsFind {
  open: boolean;
  query: string;
}

let find: SettingsFind = { open: false, query: "" };
const listeners = new Set<() => void>();

export function getSettingsFind(): SettingsFind {
  return find;
}

export function subscribeSettingsFind(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSettingsFind(patch: Partial<SettingsFind>): void {
  find = { ...find, ...patch };
  for (const listener of listeners) listener();
}

/** How long a page that comes up may still light the setting it was opened for. */
const FLASH_WAIT_MS = 3000;

/** The text a search opened a page to light, until it is lit. */
let flash: { page: RadioPage; text: string; at: number } | null = null;

/**
 * The text to light on `page`, if a search opened it a moment ago. It stays
 * until `flashDone`, since a page may be drawn twice before it settles.
 */
export function flashFor(page: RadioPage, now = Date.now()): string | null {
  return flash && flash.page === page && now - flash.at < FLASH_WAIT_MS ? flash.text : null;
}

export function flashDone(): void {
  flash = null;
}

/**
 * Opens the setting's page and has it light the setting. The page alone goes
 * up, as iPhone Settings has it, so Back comes straight back to the results.
 */
export function openSetting(s: Setting, ctx: SettingContext, now = Date.now()): void {
  flash = s.label || s.group ? { page: s.page, text: settingName(s, ctx), at: now } : null;
  setStack("radio", [{ kind: "radio", page: s.page }]);
}
