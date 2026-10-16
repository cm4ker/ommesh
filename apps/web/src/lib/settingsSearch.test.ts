import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceInfo } from "@meshnet/meshcore";
import { t } from "../i18n/index.js";
import { getNav } from "./nav.js";
import { findSettings, flashDone, flashFor, openSetting, SETTINGS, settingName, settingPlace, settingRows, type SettingContext } from "./settingsSearch.js";

const device = (protocol: number) => ({ firmwareVerCode: protocol, maxContacts: 350, maxChannels: 40, blePin: 0, buildDate: "", manufacturer: "Xiao C6", firmwareVersion: "v1.18.0", repeatEnabled: false, pathHashMode: 0 }) as unknown as DeviceInfo;
const ctx = (patch: Partial<SettingContext> = {}): SettingContext => ({ device: device(14), wifi: true, console: true, share: false, sharedSettings: false, another: false, maxTxPower: 22, ...patch });
const found = (query: string, c = ctx()) => findSettings(query, c);
const pages = (query: string, c = ctx()) => found(query, c).map((s) => `${s.page}:${s.label ?? s.group ?? ""}`);

test("a setting is found by its name, a page before the rows that rank alike", () => {
  assert.equal(pages("bluetooth")[0], "pin:");
  assert.deepEqual(pages("large emoji"), ["appearance:radio.appearance.largeEmoji"]);
  assert.equal(found("")[0], undefined);
});

test("a setting is found by the words people call it by", () => {
  const password = pages("password");
  assert.ok(password.includes("wifi:radio.wifi.password"));
  assert.ok(password.includes("pin:"));
  assert.equal(pages("868")[0], "frequency:");
  assert.ok(pages("scope").includes("frequency:radio.region.title"));
});

test("case, ё and a Cyrillic lookalike in place of a Latin letter do not matter", () => {
  assert.equal(pages("BLUETOOTH")[0], "pin:");
  // The first letter is the Cyrillic Р.
  assert.ok(pages("Рin").includes("pin:"));
});

test("what the radio or the app does not offer is not found", () => {
  assert.ok(!pages("wi-fi", ctx({ wifi: false })).some((p) => p.startsWith("wifi:")));
  assert.ok(!pages("console", ctx({ console: false })).includes("console:"));
  const older = ctx({ device: device(13) });
  assert.ok(!pages("turn off", older).includes("power:radio.power.off"));
  assert.ok(pages("turn off").includes("power:radio.power.off"));
  assert.ok(!pages("region", ctx({ device: device(10) })).includes("frequency:radio.region.title"));
  assert.ok(!settingRows(ctx({ device: null })).some((s) => s.page === "pin"));
});

test("a setting says where it is: the page it opens from, its page and its group", () => {
  const own = SETTINGS.find((s) => s.label === "radio.pin.own")!;
  assert.equal(settingPlace(own), [t("radio.titles.connection"), t("radio.titles.pin"), t("radio.pin.group")].join(" › "));
  const page = SETTINGS.find((s) => s.page === "pin" && !s.label && !s.group)!;
  assert.equal(settingPlace(page), t("radio.titles.connection"));
  assert.equal(settingName(SETTINGS.find((s) => s.label === "radio.frequency.txPower")!, ctx({ maxTxPower: 30 })), t("radio.frequency.txPower", { max: 30 }));
});

test("opening a setting puts its page alone up, lit until it is lit or a moment has passed", () => {
  const own = SETTINGS.find((s) => s.label === "radio.pin.own")!;
  openSetting(own, ctx(), 1000);
  const nav = getNav();
  assert.equal(nav.section, "radio");
  assert.deepEqual(nav.stacks.radio, [{ kind: "radio", page: "pin" }]);
  assert.equal(flashFor("connection", 1100), null);
  // A page drawn twice as it comes up finds it both times.
  assert.equal(flashFor("pin", 1100), t("radio.pin.own"));
  assert.equal(flashFor("pin", 1200), t("radio.pin.own"));
  assert.equal(flashFor("pin", 5000), null);
  flashDone();
  assert.equal(flashFor("pin", 1300), null);
});

test("every setting has a name and a place", () => {
  for (const s of SETTINGS) {
    assert.ok(settingName(s, ctx()).length > 0, `${s.page} ${s.label ?? s.group ?? ""}`);
    assert.doesNotThrow(() => settingPlace(s));
  }
});
