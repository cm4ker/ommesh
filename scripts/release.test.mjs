import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { makeManifest, newerBuild, pruneDevReleases, publish, releaseInfo, releaseNews } from "./release.mjs";

const env = { GITHUB_REF: "refs/heads/master", GITHUB_EVENT_NAME: "push", GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: "2" };
test("stable tags must match the shared version; dev runs and retries have unique versions", () => {
  assert.deepEqual(releaseInfo("0.2.0", env), { version: "0.2.0-dev.42.2", tag: "dev-0.2.0-dev.42.2", channel: "dev", publish: true });
  assert.equal(releaseInfo("0.2.0", { ...env, GITHUB_REF: "refs/tags/v0.2.0" }).version, "0.2.0");
  assert.throws(() => releaseInfo("0.2.0", { ...env, GITHUB_REF: "refs/tags/v0.3.0" }), /match/);
  assert.equal(releaseInfo("0.2.0", { ...env, GITHUB_EVENT_NAME: "pull_request" }).publish, false);
  assert.equal(releaseInfo("0.2.0", { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }).publish, false);
});
const files = [
  "Ommesh_0.2.0_x64-setup.exe", "Ommesh_0.2.0_arm64-setup.exe", "Ommesh_0.2.0_x86-setup.exe",
  "Ommesh_0.2.0_universal.app.tar.gz",
  "Ommesh_0.2.0_amd64.AppImage", "Ommesh_0.2.0_amd64.deb", "Ommesh_0.2.0_aarch64.AppImage", "Ommesh_0.2.0_arm64.deb",
].flatMap((name) => [name, `${name}.sig`]);
const options = { version: "0.2.0", tag: "v0.2.0", repository: "cm4ker/ommesh", files, signature: () => "signed-package\n", date: "2026-09-22T00:00:00Z" };
test("feed selects the exact architecture and immutable release files", () => {
  const manifest = makeManifest(options);
  assert.deepEqual(Object.keys(manifest.platforms), [
    "windows-x86_64", "windows-aarch64", "windows-i686", "darwin-aarch64", "darwin-x86_64",
    "linux-x86_64", "linux-x86_64-deb", "linux-aarch64", "linux-aarch64-deb",
  ]);
  assert.match(manifest.platforms["windows-i686"].url, /\/v0.2.0\/Ommesh_0.2.0_x86-setup.exe$/);
  assert.match(manifest.platforms["windows-aarch64"].url, /\/v0.2.0\/Ommesh_0.2.0_arm64-setup.exe$/);
  assert.equal(manifest.platforms["windows-x86_64"].signature, "signed-package");
});
test("both kinds of Mac take the universal archive, and Linux the package it was installed from", () => {
  const { platforms } = makeManifest(options);
  assert.match(platforms["darwin-aarch64"].url, /\/Ommesh_0.2.0_universal.app.tar.gz$/);
  assert.equal(platforms["darwin-x86_64"].url, platforms["darwin-aarch64"].url);
  assert.match(platforms["linux-x86_64"].url, /_amd64.AppImage$/);
  assert.match(platforms["linux-x86_64-deb"].url, /_amd64.deb$/);
  assert.match(platforms["linux-aarch64"].url, /_aarch64.AppImage$/);
  assert.match(platforms["linux-aarch64-deb"].url, /_arm64.deb$/);
});
test("the unsigned offline installers with WebView2 inside stay out of the feed", () => {
  const offline = ["x64", "arm64", "x86"].map((arch) => `Ommesh_0.2.0_${arch}-offline-setup.exe`);
  assert.deepEqual(makeManifest({ ...options, files: [...offline, ...files] }), makeManifest(options));
});
test("the disk image and the README's fixed-name download copies stay out of the feed", () => {
  const copies = [
    ...["x64", "arm64", "x86"].map((arch) => `Ommesh-setup-${arch}.exe`),
    "Ommesh_0.2.0_universal.dmg", "Ommesh-macos.dmg",
    ...["x64", "arm64"].flatMap((arch) => [`Ommesh-linux-${arch}.AppImage`, `Ommesh-linux-${arch}.deb`]),
  ];
  assert.deepEqual(makeManifest({ ...options, files: [...copies, ...files] }), makeManifest(options));
});
test("never publish a partial or mismatched update", () => {
  assert.throws(() => makeManifest({ ...options, files: files.slice(0, 2) }), /arm64/);
  assert.throws(() => makeManifest({ ...options, files: files.slice(0, 4) }), /x86/);
  assert.throws(() => makeManifest({ ...options, files: files.slice(1) }), /x64/);
  assert.throws(() => makeManifest({ ...options, files: files.filter((f) => !f.includes(".app.tar.gz")) }), /macOS/);
  assert.throws(() => makeManifest({ ...options, files: files.filter((f) => !f.endsWith("_arm64.deb")) }), /Linux ARM64 .deb/);
  assert.throws(() => makeManifest({ ...options, files: files.filter((f) => !f.endsWith("arm64-setup.exe.sig")) }), /signature/);
  assert.throws(() => makeManifest({ ...options, files: files.filter((f) => !f.endsWith("AppImage.sig")) }), /signature for Linux x64 AppImage/);
  assert.throws(() => makeManifest({ ...options, signature: () => " " }), /Empty signature/);
  assert.throws(() => makeManifest({ ...options, version: "0.3.0" }), /version/);
  assert.throws(() => makeManifest({ ...options, files: [...files, files[0]] }), /exactly one/);
});

function publication(t) {
  const directory = mkdtempSync(join(tmpdir(), "meshnet-release-test-"));
  t.after(() => {
    // Remove only the test-created directory, never a supplied path.
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith("meshnet-release-test-"));
    rmSync(directory, { recursive: true });
  });
  const version = "0.2.0-dev.42.1";
  const devFiles = files.map((name) => name.replace("0.2.0", version));
  writeFileSync(join(directory, "latest.json"), JSON.stringify(makeManifest({ ...options, version, tag: "dev-test", files: devFiles })));
  for (const name of devFiles) writeFileSync(join(directory, name), "test fixture");
  return { directory, info: { version, channel: "dev", tag: "dev-test", publish: true }, env: { GITHUB_REPOSITORY: "cm4ker/ommesh", GITHUB_SHA: "abc" } };
}

test("publishes the complete immutable release before updating the rolling feed", (t) => {
  const { directory, info, env } = publication(t);
  const calls = [];
  publish(info, directory, env, (...args) => {
    calls.push(args);
    if (args[1] === "download") return JSON.stringify({ version: "0.2.0-dev.41.1" });
    if (args[0] === "api") return JSON.stringify({ draft: false, assets: ["Meshnet_0.1.0_x64-setup.exe", "Ommesh_0.1.0_universal.dmg", "Ommesh_0.1.0_amd64.AppImage.sig", "latest.json"].map((name) => ({ name })) });
    return "";
  });
  assert.deepEqual(calls.slice(0, 3).map((call) => call.slice(0, 3)), [["release", "create", "dev-test"], ["release", "upload", "dev-test"], ["release", "edit", "dev-test"]]);
  assert.ok(calls[0].includes("--draft"));
  assert.ok(calls[1].some((arg) => arg.endsWith("arm64-setup.exe.sig")));
  assert.ok(calls[1].some((arg) => arg.endsWith("x64-setup.exe.sig")));
  assert.ok(calls[2].includes("--draft=false"));
  assert.deepEqual(calls.at(-1).slice(0, 3), ["release", "upload", "dev"]);
  assert.equal(basename(calls.at(-1).at(-1)), "latest.json");
  const removals = calls.filter((call) => call[1] === "delete-asset");
  assert.deepEqual(removals.map((call) => call.slice(2, 4)), [["dev", "Meshnet_0.1.0_x64-setup.exe"], ["dev", "Ommesh_0.1.0_universal.dmg"], ["dev", "Ommesh_0.1.0_amd64.AppImage.sig"]]);
});

test("an upload failure or stale build never changes the channel feed", (t) => {
  const { directory, info, env } = publication(t);
  const calls = [];
  assert.throws(() => publish(info, directory, env, (...args) => {
    calls.push(args);
    if (args[1] === "upload") throw new Error("upload failed");
    return "";
  }), /upload failed/);
  assert.equal(calls.length, 2);
  calls.length = 0;
  publish(info, directory, env, (...args) => { calls.push(args); return args[1] === "download" ? JSON.stringify({ version: "0.2.0-dev.43.1" }) : ""; });
  assert.equal(calls.some((call) => call[2] === "dev" && call[1] !== "download"), false);
});

test("a server error on the rolling feed's upload is tried again, other errors are not", (t) => {
  const { directory, info, env } = publication(t);
  const feed = (call) => call[1] === "upload" && call[2] === "dev" && basename(call.at(-1)) === "latest.json";
  const calls = [];
  const pauses = [];
  let failed = 0;
  publish(info, directory, env, (...args) => {
    calls.push(args);
    if (args[1] === "download") return JSON.stringify({ version: "0.2.0-dev.41.1" });
    if (args[0] === "api") return JSON.stringify({ draft: false, assets: [] });
    if (feed(args) && failed++ < 2) throw Object.assign(new Error("Command failed"), { stderr: "HTTP 500 (https://api.github.com/repos/cm4ker/ommesh/releases/assets/1)\n" });
    return "";
  }, (ms) => pauses.push(ms));
  assert.equal(calls.filter(feed).length, 3);
  assert.deepEqual(pauses, [5000, 10000]);
  assert.throws(() => publish(info, directory, env, (...args) => {
    if (args[1] === "download") return JSON.stringify({ version: "0.2.0-dev.41.1" });
    if (args[0] === "api") return JSON.stringify({ draft: false, assets: [] });
    if (feed(args)) throw Object.assign(new Error("Command failed"), { stderr: "HTTP 422: Validation Failed\n" });
    return "";
  }, () => assert.fail("a client error is not tried again")), /Command failed/);
});

test("a build reaches the feed when it is newer than the feed, even if master moved on", () => {
  assert.equal(newerBuild("0.2.0-dev.47.1", "0.2.0-dev.45.1"), true);
  assert.equal(newerBuild("0.2.0-dev.45.2", "0.2.0-dev.45.1"), true);
  assert.equal(newerBuild("0.2.0-dev.9.1", "0.2.0-dev.10.1"), false);
  assert.equal(newerBuild("0.2.0-dev.45.1", "0.2.0-dev.45.1"), false);
  assert.equal(newerBuild("0.2.0-dev.1.1", "garbage"), true);
});

test("only the two newest dev builds keep their releases", () => {
  const calls = [];
  const listed = ["dev", "dev-0.3.0-dev.9.1", "v0.2.0", "dev-0.3.0-dev.112.1", "dev-0.3.0-dev.110.2", "dev-0.3.0-dev.113.1", "dev-0.3.0-dev.110.1"];
  pruneDevReleases("cm4ker/ommesh", (...args) => {
    calls.push(args);
    return args[1] === "list" ? JSON.stringify(listed.map((tagName) => ({ tagName }))) : "";
  });
  assert.ok(calls[0].includes("--exclude-drafts"));
  const removed = calls.filter((call) => call[1] === "delete");
  assert.deepEqual(removed.map((call) => call[2]), ["dev-0.3.0-dev.110.2", "dev-0.3.0-dev.110.1", "dev-0.3.0-dev.9.1"]);
  assert.ok(removed.every((call) => call.includes("--cleanup-tag") && call.includes("--yes")));
});

const news = {
  version: "0.2.0",
  date: "2026-09-24",
  items: [
    { kind: "new", en: { title: "Pins", text: "A chat can be pinned." }, ru: { title: "Закрепы", text: "Чат можно закрепить." } },
    { kind: "fix", en: "Apply keeps repeat on.", ru: "«Применить» не выключает ретрансляцию." },
  ],
};

test("the feed carries the version's news, and notes in both languages for older clients", () => {
  const manifest = makeManifest({ ...options, news });
  assert.deepEqual(manifest.news, news);
  assert.equal(manifest.notes, "• Pins\nFixed: 1\n\n• Закрепы\nИсправлено: 1");
  assert.equal("news" in makeManifest(options), false);
  assert.match(makeManifest(options).notes, /^Ommesh 0\.2\.0\nRelease details: /);
});

test("a stable release needs its news, and a Dev build takes them once written", () => {
  const stable = { version: "0.2.0", channel: "stable" };
  const dev = { version: "0.2.0-dev.42.1", channel: "dev" };
  assert.throws(() => releaseNews(stable, () => null), /Write apps\/web\/src\/news\/0\.2\.0\.json/);
  assert.throws(() => releaseNews(stable, () => ({ ...news, items: [{ kind: "fix", en: "Only English." }] })), /no ru line/);
  assert.deepEqual(releaseNews(stable, () => news), news);
  assert.deepEqual(releaseNews(dev, (version) => (version === "0.2.0" ? news : null)), news);
  assert.equal(releaseNews(dev, () => null), null);
  assert.equal(releaseNews(dev, () => ({ version: "0.2.0" })), null);
});

test("a stable release's page says what it brings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "meshnet-release-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith("meshnet-release-test-"));
    rmSync(directory, { recursive: true });
  });
  writeFileSync(join(directory, "latest.json"), JSON.stringify(makeManifest({ ...options, news })));
  const calls = [];
  publish({ version: "0.2.0", channel: "stable", tag: "v0.2.0", publish: true }, directory, { GITHUB_REPOSITORY: "cm4ker/ommesh", GITHUB_SHA: "abc" }, (...args) => {
    calls.push(args);
    return "";
  });
  const notes = readFileSync(join(directory, "release-notes.md"), "utf8");
  assert.match(notes, /^## What's new\n\n- \*\*Pins\.\*\* A chat can be pinned\./);
  assert.match(notes, /## Что нового/);
  assert.match(notes, /Built from abc\.\n$/);
  assert.ok(calls[0].includes("--notes-file"));
});
