import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHex, toHex } from "@meshnet/meshcore";
import { isFault, keyDigits, keyFileName, readKey, writeKeyFile } from "./keyFile.js";

// The test client pair the firmware checks every imported key against (`src/Identity.cpp`).
const PRIVATE = "7065e18fd9fabb70c1ed90dca19907de698c88b709ea146eafd93d9b830c7b60c4681193c79bbc39945ba8064104bb618f8fd7a84a0af6f57033d6e8ddcd6471";
const PUBLIC = "1ec77175b0918ed206f9ae04ec136d6d5d4315bb26305427f645b492e9350c10";

test("a saved key reads back with the radio's name and when it was saved", () => {
  const now = Date.UTC(2026, 9, 13, 8, 12);
  const file = writeKeyFile({ name: "Node-21", key: PUBLIC }, fromHex(PRIVATE), "Ommesh 0.8.1", now);
  const found = readKey(JSON.stringify(file, null, 2));
  assert.ok(!isFault(found));
  assert.equal(toHex(found.privateKey), PRIVATE);
  assert.equal(found.publicKey, PUBLIC);
  assert.equal(found.name, "Node-21");
  assert.equal(found.saved, now);
});

test("bare hex is read as pasted: spaces, line breaks, capitals and 0x are no matter", () => {
  const pasted = `0x${PRIVATE.slice(0, 64).toUpperCase()}\n  ${PRIVATE.slice(64, 100)} ${PRIVATE.slice(100)}\n`;
  const found = readKey(pasted);
  assert.ok(!isFault(found));
  assert.equal(found.publicKey, PUBLIC);
  assert.equal(found.name, null);
  assert.equal(keyDigits(pasted).length, 128);
});

test("what is no key says why", () => {
  assert.deepEqual(readKey("  \n"), { fault: "empty" });
  assert.deepEqual(readKey(PRIVATE.slice(0, 96)), { fault: "length", digits: 96 });
  assert.deepEqual(readKey(`${PRIVATE}00`), { fault: "length", digits: 130 });
  assert.deepEqual(readKey(`${PRIVATE.slice(0, 127)}g`), { fault: "notHex" });
  assert.deepEqual(readKey(JSON.stringify({ format: "ommesh-history", version: 1 })), { fault: "notKey" });
  assert.deepEqual(readKey("{ not json"), { fault: "notKey" });
  assert.deepEqual(readKey(JSON.stringify({ format: "ommesh-key", version: 2, privateKey: PRIVATE })), { fault: "newer" });
  // The scalar not clamped: 64 bytes that were never an ed25519 key.
  assert.deepEqual(readKey(`71${PRIVATE.slice(2)}`), { fault: "shape" });
});

test("the file is named after the radio and the day", () => {
  assert.equal(keyFileName("Node 21/Дача", new Date(2026, 9, 3).getTime()), "ommesh-key-Node-21-Дача-2026-10-03.json");
  assert.equal(keyFileName("...", new Date(2026, 9, 3).getTime()), "ommesh-key-radio-2026-10-03.json");
});
