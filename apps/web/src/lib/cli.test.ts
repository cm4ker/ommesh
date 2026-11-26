import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McrsCap, type McrsInfo } from "@meshnet/meshcore";
import { CLI_GROUPS, CLI_GROUP_TITLE, COMMANDS, MCRS_NODE_COMMANDS, MCRS_RADIO_COMMANDS, RADIO_COMMANDS, commandsFor, consoleAssist, stepHistory, stepPick, suggest } from "./cli.js";

const labels = (draft: string) => suggest(draft).chips.map((c) => c.label);

/** The words of the reference, as the app ships them. */
const words = (code: string) => JSON.parse(readFileSync(new URL(`../i18n/${code}/cli.json`, import.meta.url), "utf8")) as Record<string, string>;

test("part of a command anywhere in it finds it: duty finds both dutycycles", () => {
  assert.deepEqual(labels("duty"), ["get dutycycle", "set dutycycle"]);
  assert.deepEqual(labels("cycle"), ["get dutycycle", "set dutycycle"]);
  assert.ok(labels("wifi").includes("set wifi.ssid"));
});

test("commands that start with what is typed come before those that only contain it", () => {
  const found = labels("set flood");
  assert.deepEqual(found.slice(0, 4), ["set flood.max", "set flood.max.advert", "set flood.max.unscoped", "set flood.advert.interval"]);
});

test("a command that takes a value says what the value is, and offers the values it takes", () => {
  assert.equal(suggest("set dutycycle ").hint, "1–100, % of airtime it may use");
  assert.equal(suggest("set dutycycle 5").hint, "1–100, % of airtime it may use");
  assert.deepEqual(suggest("set repeat ").chips, [
    { label: "on", fill: "set repeat on" },
    { label: "off", fill: "set repeat off" },
  ]);
  assert.deepEqual(labels("set repeat"), ["on", "off"]);
  assert.deepEqual(labels("set loop.detect m"), ["minimal", "moderate"]);
  assert.deepEqual(labels("set repeat on"), []);
  // "set flood.max " is its own command, not the start of "set flood.max.advert".
  assert.equal(suggest("set flood.max ").hint, "hops, 0–64");
});

test("a word with subcommands offers them, and each goes on to its own value", () => {
  assert.ok(labels("region ").includes("home"));
  assert.deepEqual(labels("gps advert "), ["none", "share", "prefs"]);
  assert.equal(suggest("region put ").hint, "region, then its parent");
});

test("nothing typed offers the everyday ones; serial-only commands are not offered at all", () => {
  assert.deepEqual(labels(""), ["ver", "clock", "neighbors", "get radio", "get dutycycle", "advert"]);
  const all = COMMANDS.map((c) => c.text.trim());
  for (const local of ["erase", "log", "stats-packets", "set freq", "get prv.key", "get acl"]) assert.ok(!all.includes(local), local);
  // "gps" asks, "gps " goes on to a value: the same word twice, but each once.
  assert.equal(new Set(COMMANDS.map((c) => c.text)).size, COMMANDS.length);
});

test("the radio's own console offers the companion's commands, not a repeater's", () => {
  const radio = (draft: string) => suggest(draft, "radio").chips.map((c) => c.label);
  assert.deepEqual(radio(""), ["ver", "get radio", "get tx", "get name", "board"]);
  assert.deepEqual(radio("set p"), ["set path.hash.mode", "set pin"]);
  assert.ok(!radio("nei").length, "no neighbours on a companion");
  assert.equal(suggest("set tz.offset ", "radio").hint, "hours from UTC, −12 to 14");
  assert.equal(new Set(RADIO_COMMANDS.map((c) => c.text)).size, RADIO_COMMANDS.length);
});

test("a suggestion says what the command does, and how many there are", () => {
  const adc = suggest("adc");
  assert.deepEqual(adc.chips.map((c) => c.label), ["get adc.multiplier", "set adc.multiplier"]);
  assert.ok(adc.chips.every((c) => c.about), "both say what they do");
  assert.equal(adc.total, 2);
  // A value says nothing about itself: it is not a command.
  assert.ok(suggest("set repeat ").chips.every((c) => !c.about));
  // More than the chips show: the field lists a few, the reference has the rest.
  const many = suggest("set");
  assert.equal(many.chips.length, 12);
  assert.ok(many.total > many.chips.length);
});

const ALL_COMMANDS = [...COMMANDS, ...RADIO_COMMANDS, ...MCRS_NODE_COMMANDS, ...MCRS_RADIO_COMMANDS];

test("every command has words in both languages", () => {
  const en = words("en");
  const ru = words("ru");
  const missing: string[] = [];
  for (const command of ALL_COMMANDS) {
    const key = command.about.replace(/^cli\./, "");
    if (!en[key]) missing.push(`en ${key}`);
    if (!ru[key]) missing.push(`ru ${key}`);
  }
  assert.deepEqual(missing, [], "a command with no words reads as its key");
});

test("no words are left over for a command that no longer exists", () => {
  const used = new Set(ALL_COMMANDS.map((command) => command.about.replace(/^cli\./, "")));
  const dead = Object.keys(words("en")).filter((key) => key.startsWith("about.") && !used.has(key));
  assert.deepEqual(dead, [], "the reference would never show these");
});

test("every command is in a group the reference knows, and each group is named in both languages", () => {
  const en = words("en");
  const ru = words("ru");
  for (const command of ALL_COMMANDS) {
    assert.ok(CLI_GROUPS.includes(command.group), `${command.text.trim()} is in no group`);
    const key = CLI_GROUP_TITLE[command.group].replace(/^cli\./, "");
    assert.ok(en[key], `en ${key}`);
    assert.ok(ru[key], `ru ${key}`);
  }
});

test("each command suggestion carries its own value hint", () => {
  const duty = suggest("duty");
  assert.equal(duty.chips[0]?.label, "get dutycycle");
  assert.equal(duty.chips[0]?.hint, undefined);
  assert.equal(duty.chips[1]?.label, "set dutycycle");
  assert.equal(duty.chips[1]?.hint, "1–100, % of airtime it may use");
});

test("arrow keys step through suggestions from either end and return to the field past the edge", () => {
  assert.equal(stepPick(null, 0, "ArrowDown"), null);
  assert.equal(stepPick(null, 0, "ArrowUp"), null);
  // Down starts at the top of the list and returns to typing freely past the bottom.
  assert.equal(stepPick(null, 3, "ArrowDown"), 0);
  assert.equal(stepPick(0, 3, "ArrowDown"), 1);
  assert.equal(stepPick(1, 3, "ArrowDown"), 2);
  assert.equal(stepPick(2, 3, "ArrowDown"), null);
  // Up starts at the row closest to the field and returns to typing freely past the top.
  assert.equal(stepPick(null, 3, "ArrowUp"), 2);
  assert.equal(stepPick(2, 3, "ArrowUp"), 1);
  assert.equal(stepPick(1, 3, "ArrowUp"), 0);
  assert.equal(stepPick(0, 3, "ArrowUp"), null);
  // One suggestion: either arrow picks it, and pressing again lets it go.
  assert.equal(stepPick(null, 1, "ArrowDown"), 0);
  assert.equal(stepPick(0, 1, "ArrowDown"), null);
  assert.equal(stepPick(null, 1, "ArrowUp"), 0);
  assert.equal(stepPick(0, 1, "ArrowUp"), null);
});

test("history walk never clears a draft on Down and restores what was typed on the way back", () => {
  const past = ["ver", "clock"];
  assert.equal(stepHistory({ index: null, draft: "", saved: "" }, [], "ArrowUp"), null);
  // Down outside history leaves the field alone instead of wiping it.
  assert.equal(stepHistory({ index: null, draft: "get r", saved: "" }, past, "ArrowDown"), null);
  // Up enters history while keeping the typed draft aside.
  const first = stepHistory({ index: null, draft: "foo", saved: "" }, past, "ArrowUp");
  assert.deepEqual(first, { index: 1, draft: "clock", saved: "foo" });
  const oldest = stepHistory(first!, past, "ArrowUp");
  assert.deepEqual(oldest, { index: 0, draft: "ver", saved: "foo" });
  // Past the oldest command it stays on it.
  assert.deepEqual(stepHistory(oldest!, past, "ArrowUp"), { index: 0, draft: "ver", saved: "foo" });
  // Walking back down steps forward and restores the held draft.
  const back = stepHistory(oldest!, past, "ArrowDown");
  assert.deepEqual(back, { index: 1, draft: "clock", saved: "foo" });
  assert.deepEqual(stepHistory(back!, past, "ArrowDown"), { index: null, draft: "foo", saved: "" });
});

test("meshcore-rs commands stay hidden on upstream targets and filter by capabilities when McrsInfo is known", () => {
  // Upstream radio/node sees none of the meshcore-rs extensions.
  assert.equal(suggest("fw", "radio").chips.length, 0);
  assert.equal(suggest("fw", "node").chips.length, 0);
  assert.equal(suggest("set screen", "radio").chips.length, 0);
  assert.equal(suggest("set dyncr", "node").chips.length, 0);

  // Full meshcore-rs lists have no duplicate command texts.
  for (const target of ["node", "radio"] as const) {
    const all = commandsFor(target, { isRs: true });
    assert.equal(new Set(all.map((c) => c.text)).size, all.length, `${target} has no duplicate commands`);
  }

  // Companion with Screen + TimeSync + Ota, but without Wifi, Led or Gps:
  const companionMcrs: McrsInfo = {
    version: 1,
    board: 7,
    role: 2,
    counter: 168,
    caps: McrsCap.Screen | McrsCap.TimeSync | McrsCap.Ota,
    productVersion: "0.9.0",
  };
  const radioSuggest = (draft: string) => suggest(draft, "radio", 12, { mcrs: companionMcrs }).chips.map((c) => c.label);
  assert.ok(radioSuggest("").includes("fw"), "fw starter offered on meshcore-rs");
  assert.ok(radioSuggest("fw ").includes("fw check"));
  assert.ok(radioSuggest("fw ").includes("fw rollback"));
  assert.deepEqual(radioSuggest("set screen "), ["auto", "manual", "off"]);
  assert.deepEqual(radioSuggest("set rtpath "), ["on", "off"]);
  assert.ok(radioSuggest("time").includes("time sync"));
  assert.ok(radioSuggest("ui.show_clock").includes("set ui.show_clock"));
  assert.equal(radioSuggest("set led").length, 0, "no LED cap -> hidden");
  assert.equal(radioSuggest("fw.server").length, 0, "no Wifi cap -> hidden");
  assert.equal(radioSuggest("gps").includes("gps"), false, "no Gps cap -> gps hidden");

  // Repeater with Wifi + Mqtt + Powersaving + BleOta:
  const repeaterMcrs: McrsInfo = {
    version: 1,
    board: 1,
    role: 1,
    counter: 170,
    caps: McrsCap.Wifi | McrsCap.Mqtt | McrsCap.Powersaving | McrsCap.BleOta | McrsCap.Ota | McrsCap.TimeSync,
    productVersion: "0.9.0",
  };
  const nodeSuggest = (draft: string) => suggest(draft, "node", 12, { mcrs: repeaterMcrs }).chips.map((c) => c.label);
  assert.ok(nodeSuggest("fw ").includes("fw ble"));
  assert.ok(!nodeSuggest("fw ").includes("fw wifi"), "no WifiOta cap -> hidden");
  assert.deepEqual(nodeSuggest("powersaving "), ["on", "off", "stats"]);
  assert.deepEqual(nodeSuggest("powersaving s"), ["stats"]);
  assert.ok(nodeSuggest("mqtt.ommesh").includes("set mqtt.ommesh"));
  assert.deepEqual(nodeSuggest("set dyncr "), ["on", "off"]);
  assert.deepEqual(nodeSuggest("set room "), ["on", "off"]);
  assert.ok(nodeSuggest("time.serve").includes("set time.serve"));
  assert.ok(nodeSuggest("sensor ").includes("sensor scan"));

  // Older -rs build without McrsInfo falls back cleanly to v1 commands via isRs.
  assert.ok(suggest("fw ", "radio", 12, { isRs: true }).chips.some((c) => c.label === "fw check"));
  assert.ok(suggest("set dyncr", "node", 12, { isRs: true }).chips.some((c) => c.label === "on"));
});

test("consoleAssist keeps value hints in flow and hides the floating list on blur or dismiss", () => {
  const base = { focused: true, recall: null, picked: null, dismissed: false, dismissedHint: null, limit: 4 };

  // Prefix typing floats matching commands while focused, without duplicating the hint bar.
  const prefix = consoleAssist({ ...base, draft: "set adc", suggestions: suggest("set adc") });
  assert.equal(prefix.showList, true);
  assert.equal(prefix.showHintBar, false);
  assert.equal(prefix.shown[0]?.label, "set adc.multiplier");

  // Blurring or dismissing hides the floating list and never pops up a stray hint bar.
  const blurred = consoleAssist({ ...base, focused: false, draft: "set adc", suggestions: suggest("set adc") });
  assert.equal(blurred.showList, false);
  assert.equal(blurred.showHintBar, false);
  const dismissed = consoleAssist({ ...base, dismissed: true, draft: "set adc", suggestions: suggest("set adc") });
  assert.equal(dismissed.showList, false);
  assert.equal(dismissed.showHintBar, false);

  // Once the command is typed and only a value hint remains, it moves into the composer bar.
  const value = consoleAssist({ ...base, draft: "set adc.multiplier 5.720", suggestions: suggest("set adc.multiplier 5.720") });
  assert.equal(value.showList, false);
  assert.equal(value.showHintBar, true);
  assert.equal(value.activeHint, "e.g. 1.0; 0 is the board's own");

  // Closing the hint bar keeps it closed while editing that same command's argument, and a new command shows its own hint.
  const closed = consoleAssist({ ...base, draft: "set adc.multiplier 5.725", suggestions: suggest("set adc.multiplier 5.725"), dismissedHint: value.activeHint });
  assert.equal(closed.showHintBar, false);
  const switched = consoleAssist({ ...base, draft: "set tx 20", suggestions: suggest("set tx 20"), dismissedHint: value.activeHint });
  assert.equal(switched.showHintBar, true);
  assert.equal(switched.activeHint, "dBm");

  // History recall suppresses both the floating list and the hint bar.
  const recalled = consoleAssist({ ...base, recall: 0, draft: "set adc.multiplier 5.720", suggestions: suggest("set adc.multiplier 5.720") });
  assert.equal(recalled.showList, false);
  assert.equal(recalled.showHintBar, false);
});
