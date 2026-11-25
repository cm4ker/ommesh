import assert from "node:assert/strict";
import test from "node:test";
import { decodeOmapp, encodeOmapp, isDevAppId, pickText, validateManifest } from "./package.js";
import type { MiniAppPackage } from "./types.js";

const validPkg: MiniAppPackage = {
  format: "omapp-v1",
  manifest: {
    schema: 1,
    id: "ommesh.chess",
    appId: 0x0100,
    version: "1.0.0",
    name: { ru: "Шахматы", en: "Chess" },
    description: { ru: "Шахматы по LoRa", en: "LoRa Chess" },
    author: "Ommesh",
    scope: "p2p",
    minProtocol: 2,
    permissions: ["peerData", "storage", "notifications"],
  },
  iconSvg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  html: "<div>Chess</div>",
};

test("round-trips a valid .omapp bundle and resolves localized text", () => {
  const bytes = encodeOmapp(validPkg);
  const decoded = decodeOmapp(bytes);
  assert.deepEqual(decoded, validPkg);
  assert.equal(pickText(decoded.manifest.name, "ru"), "Шахматы");
  assert.equal(pickText(decoded.manifest.name, "en"), "Chess");
  assert.equal(isDevAppId(0x0100), false);
  assert.equal(isDevAppId(0xff01), true);
});

test("rejects invalid manifests (p2p with appId 0, standalone with non-zero appId, bad permission)", () => {
  assert.ok(validateManifest({ ...validPkg.manifest, appId: 0 }));
  assert.ok(validateManifest({ ...validPkg.manifest, scope: "standalone", appId: 0x0100 }));
  assert.equal(validateManifest({ ...validPkg.manifest, scope: "standalone", appId: 0 }), null);
  assert.ok(validateManifest({ ...validPkg.manifest, permissions: ["network"] }));
});
