import { test } from "node:test";
import assert from "node:assert/strict";
import { fromUtf8, utf8, type PeerSide } from "@meshnet/meshcore";
import { SettingsSync, type Many, type One } from "./settingsSync.js";

/** Two settings and a family of a chat's own, kept in plain variables, with what went to the other app. */
function rig(side: PeerSide | null = "computer") {
  const state = { theme: "system", jumbo: true, chats: {} as Record<string, string>, pins: {} as Record<string, { at: number }>, radio: "r1" };
  const told: [string, unknown][] = [];
  let now = 1000;
  let enabled = true;
  let link: PeerSide | null = side;
  const sync = new SettingsSync({
    side: () => link,
    tell: (key, value) => told.push([key, JSON.parse(fromUtf8(value))]),
    enabled: () => enabled,
    times: {},
    held: {},
    saveHeld: () => {},
    saveTimes: () => {},
    now: () => now,
  });
  const theme: One<string> = { key: "theme", read: () => state.theme, write: (v) => (state.theme = v), valid: (v): v is string => typeof v === "string", fallback: "system" };
  const jumbo: One<boolean> = { key: "jumbo", read: () => state.jumbo, write: (v) => (state.jumbo = v), valid: (v): v is boolean => typeof v === "boolean", fallback: true };
  const chats: Many<string> = {
    key: "bg",
    entries: () => state.chats,
    write: (id, v) => {
      state.chats = { ...state.chats };
      if (v === null) delete state.chats[id];
      else state.chats[id] = v;
    },
    valid: (v): v is string => v === "planets" || v === "doodles",
  };
  const pins: Many<{ at: number }> = {
    key: "pin",
    entries: () => state.pins,
    write: (id, v) => {
      state.pins = { ...state.pins };
      if (v === null) delete state.pins[id];
      else state.pins[id] = v;
    },
    valid: (v): v is { at: number } => typeof v === "object" && v !== null,
    untouched: (pin) => pin.at === 0,
    scope: () => state.radio,
  };
  return {
    state,
    told,
    sync,
    start() {
      sync.share(theme);
      sync.share(jumbo);
      sync.shareEach(chats);
      sync.shareEach(pins);
      return this;
    },
    at(ms: number) {
      now = ms;
      return this;
    },
    off() {
      enabled = false;
    },
    on() {
      enabled = true;
      sync.resume();
    },
    away() {
      link = null;
    },
    hear(key: string, value: unknown) {
      sync.take(key, utf8(JSON.stringify(value)));
    },
  };
}

test("a setting changed here goes to the other app with the time it changed", () => {
  const r = rig().start();
  r.at(5000).state.theme = "amber";
  r.sync.look();
  assert.deepEqual(r.told, [["s:theme", [5000, "amber"]]]);
  r.sync.look();
  assert.equal(r.told.length, 1, "once");
});

test("a chat's own setting goes as an entry of its own, and one put back as null", () => {
  const r = rig().start();
  r.at(5000).state.chats = { "ch:0": "planets" };
  r.sync.look();
  r.at(6000).state.chats = {};
  r.sync.look();
  assert.deepEqual(r.told, [
    ["s:bg:ch:0", [5000, "planets"]],
    ["s:bg:ch:0", [6000, null]],
  ]);
});

test("the later change wins, either way", () => {
  const r = rig().start();
  r.at(5000).state.theme = "amber";
  r.sync.look();
  r.hear("s:theme", [4000, "olive"]);
  assert.equal(r.state.theme, "amber", "an older one is not taken");
  r.hear("s:theme", [7000, "olive"]);
  assert.equal(r.state.theme, "olive");
  r.sync.look();
  assert.equal(r.told.length, 1, "and is not told back");
  r.hear("s:bg:ch:1", [8000, "doodles"]);
  assert.deepEqual(r.state.chats, { "ch:1": "doodles" });
  r.hear("s:bg:ch:1", [9000, null]);
  assert.deepEqual(r.state.chats, {}, "an entry put back goes back here too");
});

test("between two changed before anyone kept times, the phone's stands", () => {
  const computer = rig("computer");
  computer.state.theme = "amber";
  computer.start();
  computer.hear("s:theme", [1, "olive"]);
  assert.equal(computer.state.theme, "olive", "the computer takes the phone's");
  const phone = rig("phone");
  phone.state.theme = "olive";
  phone.start();
  phone.hear("s:theme", [1, "amber"]);
  assert.equal(phone.state.theme, "olive", "the phone keeps its own");
  phone.hear("s:jumbo", [1, false]);
  assert.equal(phone.state.jumbo, false, "but takes what it never changed");
});

test("catching up tells what was ever changed here, entries put back too, and nothing left as it came", () => {
  const r = rig();
  r.state.theme = "amber";
  r.state.pins = { "ch:0": { at: 0 }, "c:ab": { at: 7 } };
  r.start();
  r.at(5000).state.chats = { "ch:3": "planets" };
  r.sync.look();
  r.at(6000).state.chats = {};
  r.sync.look();
  r.told.length = 0;
  r.sync.tellAll();
  assert.deepEqual(
    r.told.sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["s:bg:ch:3", [6000, null]],
      ["s:pin:c:ab", [1, { at: 7 }]],
      ["s:theme", [1, "amber"]],
    ],
    "Public's pin nobody chose stays behind",
  );
});

test("pins of another radio are not changes", () => {
  const r = rig().start();
  r.state.radio = "r2";
  r.state.pins = { "c:ff": { at: 9 } };
  r.sync.look();
  assert.deepEqual(r.told, []);
});

test("what came while off is taken when turned on, and what is here goes then", () => {
  const r = rig().start();
  r.off();
  r.hear("s:jumbo", [9000, false]);
  r.hear("s:jumbo", [9500, true]);
  r.hear("s:theme", [9000, "olive"]);
  r.at(5000).state.chats = { "ch:0": "planets" };
  r.sync.look();
  assert.equal(r.told.length, 0, "nothing goes while off");
  r.on();
  assert.equal(r.state.theme, "olive");
  assert.equal(r.state.jumbo, true, "the latest of each");
  assert.deepEqual(
    r.told.find(([key]) => key === "s:bg:ch:0"),
    ["s:bg:ch:0", [5000, "planets"]],
  );
});

test("a change made after one taken is dated after it, whatever this clock says", () => {
  const r = rig().start();
  r.hear("s:theme", [9000, "olive"]);
  r.at(5000).state.theme = "amber";
  r.sync.look();
  assert.deepEqual(r.told, [["s:theme", [9001, "amber"]]]);
});

test("off, nothing goes and nothing is taken; nor while the radio is not shared", () => {
  const r = rig().start();
  r.off();
  r.state.theme = "amber";
  r.sync.look();
  r.hear("s:jumbo", [9000, false]);
  assert.deepEqual(r.told, []);
  assert.equal(r.state.jumbo, true);
  const away = rig().start();
  away.away();
  away.state.theme = "amber";
  away.sync.look();
  away.sync.tellAll();
  assert.deepEqual(away.told, []);
});

test("what this app would not take, or does not know, is left", () => {
  const r = rig().start();
  r.hear("s:bg:ch:0", [9000, "plaid"]);
  r.hear("s:unknown", [9000, 1]);
  r.hear("s:theme", "not a pair");
  r.sync.take("s:theme", utf8("{"));
  assert.deepEqual(r.state.chats, {});
  assert.equal(r.state.theme, "system");
});
