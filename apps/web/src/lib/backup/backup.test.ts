import { test } from "node:test";
import assert from "node:assert/strict";
import { ContactFlag, fromHex, type ContactRecord, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { isFault, readKey } from "../keyFile.js";
import { readHistorySource } from "../history/plan.js";
import { BackupFileError, backupFileName, parseBackup, writeBackup } from "./format.js";
import { copyOf, movedSettings, overflow, partsAvailable, planRestore, RESTORE_PARTS, type RestorePart } from "./plan.js";

// The test client pair the firmware checks every imported key against (`src/Identity.cpp`).
const PRIVATE = "7065e18fd9fabb70c1ed90dca19907de698c88b709ea146eafd93d9b830c7b60c4681193c79bbc39945ba8064104bb618f8fd7a84a0af6f57033d6e8ddcd6471";
const PUBLIC = "1ec77175b0918ed206f9ae04ec136d6d5d4315bb26305427f645b492e9350c10";
const NEW = "f0".repeat(32);
const BOB = "b0".repeat(32);
const ANN = "a0".repeat(32);
const VIC = "c0".repeat(32);
const PUBLIC_SECRET = "8b3387e9c5cdea6ac9e5edbaa115cd72";
const TEST_SECRET = "9cd8fcf22a47333b591d96a2b848b73f";
const NOW = Date.UTC(2026, 9, 22, 8, 12);
const S = NOW / 1000;

function contact(key: string, name: string, extra: Partial<ContactRecord> = {}): ContactRecord {
  return { key, prefix: key.slice(0, 12), type: 1, flags: 0, outPathLen: 0xff, outPath: "".padEnd(128, "0"), name, lastAdvert: S - 600, lat: 0, lon: 0, lastMod: S - 600, lastHeardAt: null, pathSince: null, ...extra };
}

function message(conversation: string, text: string): MessageRecord {
  return {
    id: text,
    conversation,
    direction: "in",
    text,
    sender: null,
    senderPrefix: null,
    timestamp: S - 100,
    receivedAt: NOW - 100_000,
    snr: null,
    hops: null,
    txtType: 0,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
  };
}

/** The old radio: Node-21 with three contacts, Public and #test, and a chat with Ann. */
function oldRadio() {
  return {
    self: {
      key: PUBLIC,
      prefix: PUBLIC.slice(0, 12),
      name: "Node-21",
      advType: 1,
      txPower: 22,
      maxTxPower: 22,
      lat: 55.75,
      lon: 37.61,
      multiAcks: 0,
      advertLocPolicy: 0,
      telemetryModeBase: 0,
      telemetryModeLocation: 0,
      telemetryModeEnvironment: 0,
      manualAddContacts: 0,
      frequencyKhz: 869_618,
      bandwidthHz: 62_500,
      spreadingFactor: 8,
      codingRate: 8,
    },
    device: { firmwareVerCode: 13, maxContacts: 350, maxChannels: 40, blePin: 482_913, buildDate: "", manufacturer: "Heltec V3", firmwareVersion: "v1.17.1", repeatEnabled: null, pathHashMode: 0 },
    tuning: { rxDelayBase: 0, airtimeFactor: 1 },
    autoAdd: null,
    region: null,
    channels: [
      { index: 0, name: "Public", secret: PUBLIC_SECRET },
      { index: 3, name: "#test", secret: TEST_SECRET },
    ],
    contacts: { [BOB]: contact(BOB, "Bob", { lastAdvert: S - 60 }), [ANN]: contact(ANN, "Ann", { lastAdvert: S - 6000 }), [VIC]: contact(VIC, "Vic", { flags: ContactFlag.Favourite, lastAdvert: S - 9000 }) },
    removed: {},
    messages: [message(`c:${ANN}`, "hello"), message("ch:3", "on test")],
    routing: { resetAfterMin: 60, contacts: { [BOB]: { flood: true } } },
    channelRegions: {},
  } as unknown as Pick<SessionState, "self" | "device" | "tuning" | "autoAdd" | "region" | "channels" | "contacts" | "removed" | "messages" | "routing" | "channelRegions">;
}

function saved(key: string | null = PRIVATE) {
  const file = writeBackup(oldRadio(), key ? fromHex(key) : null, { theme: "amber", "chatLevel:ch:3": "off", [`pin:${PUBLIC.slice(0, 12)}/ch:3`]: { at: 5 } }, "Ommesh 0.9.1", NOW);
  return parseBackup(JSON.stringify(file, null, 2));
}

/** A new radio, fresh from the box: its own key, Public alone, room for `room` contacts. */
function newRadio(room = 350) {
  return { self: { key: NEW }, device: { maxContacts: room }, contacts: {}, channels: [{ index: 0, name: "Public", secret: PUBLIC_SECRET }], now: NOW };
}

test("a copy reads back as it was written: key, settings, channels, history and app", () => {
  const file = saved();
  assert.equal(file.key?.privateKey, PRIVATE);
  assert.equal(file.radio.name, "Node-21");
  assert.deepEqual(file.radio.settings.radio, { frequencyKhz: 869_618, bandwidthHz: 62_500, spreadingFactor: 8, codingRate: 8 });
  assert.equal(file.radio.settings.blePin, 482_913);
  assert.deepEqual(file.radio.channels.map((c) => c.slot), [0, 3]);
  assert.equal(file.history.contacts.length, 3);
  assert.deepEqual(file.app.routing, { resetAfterMin: 60, contacts: { [BOB]: { flood: true } } });
  assert.equal(backupFileName("Node 21", NOW), "ommesh-backup-Node-21-2026-10-22.json");
});

test("a copy whose key is not the radio's, or a file of another kind, is refused", () => {
  const file = JSON.parse(JSON.stringify(writeBackup(oldRadio(), fromHex(PRIVATE), {}, "Ommesh", NOW)));
  file.radio.publicKey = NEW;
  file.history.radio.key = NEW;
  assert.throws(() => parseBackup(JSON.stringify(file)), (e: unknown) => e instanceof BackupFileError && e.path === "key.privateKey");
  assert.throws(() => parseBackup(JSON.stringify({ format: "ommesh-history", version: 1 })), (e: unknown) => e instanceof BackupFileError && e.kind === "notBackup");
  assert.throws(() => parseBackup(JSON.stringify({ ...file, version: 2 })), (e: unknown) => e instanceof BackupFileError && e.kind === "newer");
});

test("the key page and the history page each take their part of a copy", () => {
  const text = JSON.stringify(writeBackup(oldRadio(), fromHex(PRIVATE), {}, "Ommesh", NOW));
  const key = readKey(text);
  assert.ok(!isFault(key));
  assert.equal(key.publicKey, PUBLIC);
  assert.equal(key.name, "Node-21");
  const history = readHistorySource(new TextEncoder().encode(text));
  assert.equal(history.radioKey, PUBLIC);
  assert.equal(history.body.messages.length, 2);
});

test("onto a new radio every part goes; favourites first, then those written with, then by the last advert", () => {
  const plan = planRestore(saved(), newRadio());
  assert.equal(plan.same, false);
  assert.deepEqual(plan.contacts.map((c) => c.name), ["Vic", "Ann", "Bob"]);
  assert.equal(plan.channels, 1, "Public is there already");
  const all = new Set(RESTORE_PARTS);
  assert.deepEqual([...partsAvailable(plan, all)].sort(), ["app", "channels", "chats", "contacts", "key", "settings"]);
  const copy = copyOf(plan, all);
  assert.equal(copy.name, "Node-21");
  assert.ok(copy.privateKey);
  assert.deepEqual(copy.channels?.map((c) => c.index), [0, 3]);
});

test("without the key the chats cannot come, nor the name; a copy without a key has no key part", () => {
  const plan = planRestore(saved(), newRadio());
  const chosen = new Set<RestorePart>(RESTORE_PARTS.filter((p) => p !== "key"));
  assert.ok(!partsAvailable(plan, chosen).has("chats"));
  const copy = copyOf(plan, chosen);
  assert.equal(copy.privateKey, undefined);
  assert.equal(copy.name, undefined);
  const keyless = planRestore(saved(null), newRadio());
  assert.ok(!partsAvailable(keyless, new Set(RESTORE_PARTS)).has("key"));
});

test("a radio with less room than the copy has contacts says how many will not fit", () => {
  const plan = planRestore(saved(), newRadio(2));
  assert.equal(overflow(plan), 1);
  assert.equal(overflow(planRestore(saved(), newRadio())), 0);
});

test("a chat's settings follow its channel to the slot it went to, and those of a channel left out are dropped", () => {
  const pin = `pin:${PUBLIC.slice(0, 12)}/ch:3`;
  assert.deepEqual(movedSettings({ theme: "amber", "chatLevel:ch:3": "off", "chatLevel:ch:5": "off", [pin]: { at: 5 }, [`chatLevel:c:${ANN}`]: "off" }, { 3: 1 }), {
    theme: "amber",
    "chatLevel:ch:1": "off",
    [`pin:${PUBLIC.slice(0, 12)}/ch:1`]: { at: 5 },
    [`chatLevel:c:${ANN}`]: "off",
  });
});
