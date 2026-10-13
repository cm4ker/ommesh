import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fromHex, toHex } from "./bytes.js";
import { privateKeyFault, publicKeyOf } from "./identity.js";

// The test client pair the firmware checks every imported key against (`src/Identity.cpp`).
const FIRMWARE_PRV = fromHex("7065e18fd9fabb70c1ed90dca19907de698c88b709ea146eafd93d9b830c7b60c4681193c79bbc39945ba8064104bb618f8fd7a84a0af6f57033d6e8ddcd6471");
const FIRMWARE_PUB = "1ec77175b0918ed206f9ae04ec136d6d5d4315bb26305427f645b492e9350c10";

/** The 64-byte key orlp/ed25519 makes from a seed: SHA-512 of it, the scalar clamped. */
function expand(seed: Uint8Array): Uint8Array {
  const key = new Uint8Array(createHash("sha512").update(seed).digest());
  key[0] = key[0]! & 248;
  key[31] = (key[31]! & 63) | 64;
  return key;
}

test("the public key is worked out as the firmware works it out", () => {
  assert.equal(toHex(publicKeyOf(FIRMWARE_PRV)), FIRMWARE_PUB);
});

test("the public keys of RFC 8032's test seeds", () => {
  const cases = [
    ["9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"],
    ["4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"],
    ["c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025"],
  ];
  for (const [seed, pub] of cases) assert.equal(toHex(publicKeyOf(expand(fromHex(seed!)))), pub);
});

test("a key the radio would refuse is told apart", () => {
  assert.equal(privateKeyFault(FIRMWARE_PRV), null);
  const unclamped = FIRMWARE_PRV.slice();
  unclamped[0] = unclamped[0]! | 1;
  assert.equal(privateKeyFault(unclamped), "shape");
  assert.equal(privateKeyFault(FIRMWARE_PRV.slice(0, 32)), "shape");
  // A key whose public key starts 00 or FF: seeds tried in turn until one comes up.
  let seed = 0;
  let key = expand(new Uint8Array([seed]));
  while (![0x00, 0xff].includes(publicKeyOf(key)[0]!)) key = expand(new Uint8Array([++seed, seed >> 8]));
  assert.equal(privateKeyFault(key), "prefix");
});
