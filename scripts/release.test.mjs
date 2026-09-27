import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { makeManifest, newerBuild, pruneDevReleases, publish, releaseInfo } from "./release.mjs";

const env = { GITHUB_REF: "refs/heads/master", GITHUB_EVENT_NAME: "push", GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: "2" };
test("stable tags must match the shared version; dev runs and retries have unique versions", () => {
  assert.deepEqual(releaseInfo("0.2.0", env), { version: "0.2.0-dev.42.2", tag: "dev-0.2.0-dev.42.2", channel: "dev", publish: true });
  assert.equal(releaseInfo("0.2.0", { ...env, GITHUB_REF: "refs/tags/v0.2.0" }).version, "0.2.0");
  assert.throws(() => releaseInfo("0.2.0", { ...env, GITHUB_REF: "refs/tags/v0.3.0" }), /match/);
  assert.equal(releaseInfo("0.2.0", { ...env, GITHUB_EVENT_NAME: "pull_request" }).publish, false);
  assert.equal(releaseInfo("0.2.0", { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }).publish, false);
});
const files = ["Ommesh_0.2.0_x64-setup.exe", "Ommesh_0.2.0_arm64-setup.exe", "Ommesh_0.2.0_x86-setup.exe"].flatMap((name) => [name, `${name}.sig`]);
const options = { version: "0.2.0", tag: "v0.2.0", repository: "cm4ker/ommesh", files, signature: () => "signed-package\n", date: "2026-09-22T00:00:00Z" };
test("feed selects the exact architecture and immutable release files", () => {
  const manifest = makeManifest(options);
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64", "windows-aarch64", "windows-i686"]);
  assert.match(manifest.platforms["windows-i686"].url, /\/v0.2.0\/Ommesh_0.2.0_x86-setup.exe$/);
  assert.match(manifest.platforms["windows-aarch64"].url, /\/v0.2.0\/Ommesh_0.2.0_arm64-setup.exe$/);
  assert.equal(manifest.platforms["windows-x86_64"].signature, "signed-package");
});
test("the unsigned offline installers with WebView2 inside stay out of the feed", () => {
  const offline = ["x64", "arm64", "x86"].map((arch) => `Ommesh_0.2.0_${arch}-offline-setup.exe`);
  assert.deepEqual(makeManifest({ ...options, files: [...offline, ...files] }), makeManifest(options));
});
test("never publish a partial or mismatched update", () => {
  assert.throws(() => makeManifest({ ...options, files: files.slice(0, 2) }), /arm64/);
  assert.throws(() => makeManifest({ ...options, files: files.slice(0, 4) }), /x86/);
  assert.throws(() => makeManifest({ ...options, files: files.slice(1) }), /x64/);
  assert.throws(() => makeManifest({ ...options, files: files.filter((f) => !f.endsWith("arm64-setup.exe.sig")) }), /signature/);
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
    if (args[0] === "api") return JSON.stringify({ draft: false, assets: [{ name: "Meshnet_0.1.0_x64-setup.exe" }, { name: "latest.json" }] });
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
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0].slice(2, 4), ["dev", "Meshnet_0.1.0_x64-setup.exe"]);
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
