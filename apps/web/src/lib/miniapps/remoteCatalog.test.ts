import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeOmapp, type MiniAppPackage } from "@ommesh/miniapp-sdk";
import { STORE_CATALOG } from "./catalog.js";
import {
  countCatalogUpdates,
  fetchCatalogPackage,
  hasCatalogUpdate,
  mergeCatalogs,
  parseRemoteCatalog,
  sha256Hex,
  type StoreCatalogItem,
} from "./remoteCatalog.js";
import type { InstalledMiniApp } from "./store.js";

function makeSamplePkg(overrides: Partial<MiniAppPackage["manifest"]> = {}): MiniAppPackage {
  return {
    format: "omapp-v1",
    manifest: {
      schema: 1,
      id: "ommesh.backgammon",
      appId: 0x0103,
      version: "1.2.0",
      name: { en: "Backgammon", ru: "Нарды" },
      description: { en: "LoRa backgammon", ru: "Нарды по LoRa" },
      author: "Ommesh",
      scope: "p2p",
      minProtocol: 2,
      permissions: ["peerData", "storage"],
      ...overrides,
    },
    iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
    html: "<div>Backgammon</div>",
  };
}

test("sha256Hex matches Node crypto SHA-256", async () => {
  const bytes = new TextEncoder().encode("ommesh-miniapps-remote-catalog");
  const want = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await sha256Hex(bytes), want);
});

test("parseRemoteCatalog validates entries and rejects unsafe filenames or scripts", () => {
  const validSha = "a".repeat(64);
  const parsed = parseRemoteCatalog({
    schema: 1,
    updatedAt: "2026-11-25T15:00:00Z",
    apps: [
      {
        id: "ommesh.backgammon",
        appId: 259,
        version: "1.0.0",
        name: { en: "Backgammon", ru: "Нарды" },
        author: "Ommesh",
        scope: "p2p",
        permissions: ["peerData"],
        verified: true,
        sizeBytes: 12000,
        sha256: validSha,
        iconSvg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>',
        file: "ommesh.backgammon.omapp",
      },
      {
        id: "evil.traversal",
        appId: 260,
        version: "1.0.0",
        name: { en: "Bad" },
        author: "Bad",
        scope: "p2p",
        permissions: [],
        verified: false,
        sizeBytes: 500,
        sha256: validSha,
        file: "../evil.omapp",
      },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.apps.length, 1);
  assert.equal(parsed.apps[0]!.id, "ommesh.backgammon");
});

test("mergeCatalogs prefers newer remote versions and adds brand-new remote apps", () => {
  const remote = parseRemoteCatalog({
    schema: 1,
    updatedAt: "2026-11-25T16:00:00Z",
    apps: [
      {
        id: "ommesh.checkers",
        appId: 257,
        version: "1.1.0",
        name: { en: "Checkers", ru: "Шашки" },
        author: "Ommesh",
        scope: "p2p",
        permissions: ["peerData", "storage", "notifications"],
        verified: true,
        sizeBytes: 132000,
        sha256: "b".repeat(64),
        file: "ommesh.checkers.omapp",
      },
      {
        id: "ommesh.backgammon",
        appId: 259,
        version: "1.0.0",
        name: { en: "Backgammon", ru: "Нарды" },
        author: "Ommesh",
        scope: "p2p",
        permissions: ["peerData", "storage"],
        verified: true,
        sizeBytes: 50000,
        sha256: "c".repeat(64),
        iconSvg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>',
        file: "ommesh.backgammon.omapp",
      },
    ],
  });

  const merged = mergeCatalogs(STORE_CATALOG, remote);
  const checkers = merged.find((i) => i.id === "ommesh.checkers")!;
  assert.equal(checkers.origin, "remote");
  assert.equal(checkers.version, "1.1.0");

  const chess = merged.find((i) => i.id === "ommesh.chess")!;
  assert.equal(chess.origin, "builtin");

  const bg = merged.find((i) => i.id === "ommesh.backgammon")!;
  assert.equal(bg.origin, "remote");
  assert.equal(bg.appId, 259);

  const installedOld: InstalledMiniApp = {
    pkg: STORE_CATALOG.find((e) => e.pkg.manifest.id === "ommesh.checkers")!.pkg,
    source: "catalog",
    installedAt: 1,
    sizeBytes: 1000,
  };
  assert.equal(hasCatalogUpdate(installedOld, checkers), true);
  assert.equal(countCatalogUpdates({ "ommesh.checkers": installedOld }, merged), 1);
});

test("fetchCatalogPackage verifies SHA-256 and rejects tampered payloads", async () => {
  const pkg = makeSamplePkg();
  const bytes = encodeOmapp(pkg);
  const sha = await sha256Hex(bytes);

  const item: StoreCatalogItem = {
    id: pkg.manifest.id,
    appId: pkg.manifest.appId,
    version: pkg.manifest.version,
    name: pkg.manifest.name,
    author: pkg.manifest.author,
    scope: pkg.manifest.scope,
    permissions: pkg.manifest.permissions,
    verified: true,
    sizeBytes: bytes.length,
    iconSvg: pkg.iconSvg,
    origin: "remote",
    remoteFile: "ommesh.backgammon.omapp",
    sha256: sha,
  };

  const goodFetcher = (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch;
  const loaded = await fetchCatalogPackage(item, { baseUrl: "https://example.test/apps", fetcher: goodFetcher });
  assert.equal(loaded.manifest.id, "ommesh.backgammon");
  assert.equal(loaded.manifest.version, "1.2.0");

  const tampered = new Uint8Array(bytes);
  const idx = tampered.length - 2;
  tampered[idx] = (tampered[idx] ?? 0) ^ 1;
  const badFetcher = (async () => new Response(tampered, { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchCatalogPackage(item, { baseUrl: "https://example.test/apps", fetcher: badFetcher }),
    /SHA-256 mismatch/,
  );

  // When primary host returns 404, fetchCatalogPackage falls back to the secondary mirror seamlessly.
  const seenUrls: string[] = [];
  const fallbackFetcher = (async (url: string) => {
    seenUrls.push(url);
    if (url.includes("cm4ker.github.io")) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as unknown as typeof fetch;
  const fromFallback = await fetchCatalogPackage(item, { fetcher: fallbackFetcher });
  assert.equal(fromFallback.manifest.id, "ommesh.backgammon");
  assert.equal(seenUrls.length, 2);
  assert.ok(seenUrls[1]!.includes("raw.githubusercontent.com/cm4ker/ommesh-miniapps/gh-pages"));
});
