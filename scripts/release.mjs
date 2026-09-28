import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function releaseInfo(base, env) {
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error("package.json must contain a stable X.Y.Z version");
  const tagged = env.GITHUB_REF?.startsWith("refs/tags/");
  if (tagged && env.GITHUB_REF !== `refs/tags/v${base}`) throw new Error("The release tag must match the version in package.json");
  const publish = env.GITHUB_EVENT_NAME === "push" && (tagged || env.GITHUB_REF === "refs/heads/master");
  const run = env.GITHUB_RUN_NUMBER ?? "0";
  const attempt = env.GITHUB_RUN_ATTEMPT ?? "1";
  if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error("Invalid build number");
  const version = tagged ? base : `${base}-dev.${run}.${attempt}`;
  return { version, channel: tagged ? "stable" : "dev", tag: tagged ? `v${base}` : `dev-${version}`, publish };
}

export function makeManifest({ version, tag, repository, files, signature, date = new Date().toISOString() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  const platforms = {};
  for (const [arch, target] of [["x64", "windows-x86_64"], ["arm64", "windows-aarch64"], ["x86", "windows-i686"]]) {
    const matches = files.filter((name) => name.endsWith(`_${arch}-setup.exe`));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${arch} installer`);
    const name = matches[0];
    if (basename(name) !== name || !name.includes(`_${version}_`)) throw new Error(`Installer version does not match ${version}`);
    if (!files.includes(`${name}.sig`)) throw new Error(`Missing signature for ${arch}`);
    const signed = signature(`${name}.sig`).trim();
    if (!signed) throw new Error(`Empty signature for ${arch}`);
    platforms[target] = { signature: signed, url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` };
  }
  return { version, notes: `Ommesh ${version}\nRelease details: https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`, pub_date: date, platforms };
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function releaseByTag(repo, tag, run = gh) {
  try { return JSON.parse(run("api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)); }
  catch (error) {
    if (String(error.stderr).includes("HTTP 404")) return null;
    throw error;
  }
}

function feedVersion(repo, run) {
  try { return JSON.parse(run("release", "download", "dev", "--repo", repo, "--pattern", "latest.json", "--output", "-")).version ?? null; }
  catch { return null; }
}

const devBuild = (version) => version.match(/-dev\.(\d+)\.(\d+)$/)?.slice(1).map(Number) ?? null;

/** Whether dev build `version` came after `than`, by run number and then attempt; a feed it cannot read loses. */
export function newerBuild(version, than) {
  const [mine, theirs] = [devBuild(version), devBuild(than)];
  if (!mine) return false;
  if (!theirs) return true;
  return mine[0] !== theirs[0] ? mine[0] > theirs[0] : mine[1] > theirs[1];
}

// Every feed points to immutable files. A published tag is never rebuilt in place.
export function publish(info, directory, env, run = gh) {
  const repo = env.GITHUB_REPOSITORY;
  const manifest = readJson(resolve(directory, "latest.json"));
  if (!info.publish || manifest.version !== info.version) throw new Error("Not a matching release build");
  const notesFile = resolve(directory, "release-notes.md");
  writeFileSync(notesFile, `${manifest.notes}\n\nBuilt from ${env.GITHUB_SHA}.\n`);
  const assets = readdirSync(directory).filter((name) => name !== "release-notes.md").map((name) => resolve(directory, name));
  run("release", "create", info.tag, "--repo", repo, "--target", env.GITHUB_SHA, "--draft", "--latest=false", "--title", `Ommesh ${info.version}`, "--notes-file", notesFile, ...(info.channel === "dev" ? ["--prerelease"] : []));
  run("release", "upload", info.tag, "--repo", repo, ...assets);
  run("release", "edit", info.tag, "--repo", repo, "--draft=false", ...(info.channel === "stable" ? ["--latest"] : ["--latest=false"]));
  if (info.channel !== "dev") return;

  // A slow older build must not move the rolling feed back past a newer one.
  // Publishing runs one at a time, so the feed read here is still the feed when
  // it is replaced below. It is not enough that master moved on: pushes closer
  // together than a build would then never reach the feed at all.
  const current = feedVersion(repo, run);
  if (current && !newerBuild(info.version, current)) {
    console.log(`Kept the current dev feed: ${current} is not older than ${info.version}.`);
    return;
  }
  const channelRelease = releaseByTag(repo, "dev", run);
  if (channelRelease?.draft) throw new Error("The dev channel release must be public");
  const manualAssets = assets.filter((path) => basename(path) !== "latest.json");
  run("release", "upload", "dev", "--repo", repo, "--clobber", ...manualAssets);
  const currentNames = new Set(manualAssets.map((path) => basename(path)));
  for (const asset of channelRelease?.assets ?? []) {
    // Only rolling download aliases are replaced here; old versioned releases go in pruneDevReleases.
    // Builds from before the rename to Ommesh were named Meshnet.
    if (/^(?:Ommesh|Meshnet).*\.(?:exe(?:\.sig)?|apk|zip)$/.test(asset.name) && !currentNames.has(asset.name)) {
      run("release", "delete-asset", "dev", asset.name, "--repo", repo, "--yes");
    }
  }
  writeFileSync(notesFile, `Latest development build: [Ommesh ${info.version}](https://github.com/${repo}/releases/tag/${info.tag}).\n\nWindows installers, Android APK and web bundle are also attached here for manual download. Desktop clients use latest.json below, which points to the immutable versioned release.\n`);
  run("release", "edit", "dev", "--repo", repo, "--prerelease", "--latest=false", "--title", `Dev · ${info.version}`, "--notes-file", notesFile);
  // This is the final write, after both architectures and their signatures exist.
  run("release", "upload", "dev", "--repo", repo, "--clobber", resolve(directory, "latest.json"));
}

/** Deletes all but the newest `keep` versioned Dev releases, with their tags. The feed
 * points to the newest; the one before stays for clients that read the old feed. */
export function pruneDevReleases(repo, run = gh, keep = 2) {
  const tags = JSON.parse(run("release", "list", "--repo", repo, "--limit", "1000", "--exclude-drafts", "--json", "tagName"))
    .map(({ tagName }) => tagName)
    .filter((tag) => /^dev-.+-dev\.\d+\.\d+$/.test(tag))
    .sort((a, b) => (newerBuild(a, b) ? -1 : newerBuild(b, a) ? 1 : 0));
  for (const tag of tags.slice(keep)) run("release", "delete", tag, "--repo", repo, "--cleanup-tag", "--yes");
}

export function main(command, directory = "out", env = process.env) {
  const info = releaseInfo(readJson(resolve(root, "package.json")).version, env);
  if (command === "prepare") {
    json(resolve(root, "apps/desktop/src-tauri/tauri.release.json"), { version: info.version, bundle: { createUpdaterArtifacts: info.publish } });
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `MESHNET_VERSION=${info.version}\n`);
    if (env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(info)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
    console.log(JSON.stringify(info));
  } else if (command === "manifest") {
    const files = readdirSync(directory);
    json(resolve(directory, "latest.json"), makeManifest({ ...info, repository: env.GITHUB_REPOSITORY, files, signature: (name) => readFileSync(resolve(directory, name), "utf8") }));
  } else if (command === "publish") {
    if (!info.publish) throw new Error("Only publishing pushes can create releases");
    // Bootstrap the channel once; existing releases and their files are kept.
    if (info.channel === "dev") {
      if (!releaseByTag(env.GITHUB_REPOSITORY, "dev")) gh("release", "create", "dev", "--repo", env.GITHUB_REPOSITORY, "--target", env.GITHUB_SHA, "--prerelease", "--latest=false", "--title", "Dev builds", "--notes", "Development builds of Ommesh.");
    }
    publish(info, directory, env);
    if (info.channel === "dev") pruneDevReleases(env.GITHUB_REPOSITORY);
  } else throw new Error("Usage: node scripts/release.mjs prepare|manifest|publish [directory]");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv[2], process.argv[3]);
