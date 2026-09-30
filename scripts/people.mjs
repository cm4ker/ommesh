/**
 * Writes the People list from GitHub: everyone whose commits are on master and
 * everyone who opened an issue. The READMEs get it between the `people:start`
 * and `people:end` comments, the rest of each left as it is. The app gets it as
 * apps/web/src/lib/people.json with the pictures in apps/web/public/people, and
 * the face its thanks line is set in, cut down to that line's letters. The
 * People workflow runs it on every new issue and push to master and commits the
 * result; `pnpm people` runs it by hand.
 * GH_TOKEN or GITHUB_TOKEN is used when set; the public API is enough without.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "cm4ker/ommesh";
const perRow = 6;
const appList = resolve(root, "apps/web/src/lib/people.json");
const pictures = resolve(root, "apps/web/public/people");
const i18n = resolve(root, "apps/web/src/i18n");
const thanksFont = resolve(root, "apps/web/src/fonts/caveat-thanks.woff2");
// Google Fonts sends WOFF2 only to a browser it knows.
const browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Whether a GitHub user can stand in the list. The People workflow runs this on
 * every new issue, so anyone can put a name here: only a well-formed login and
 * a GitHub-hosted picture reach the README's HTML. "ghost" stands for deleted accounts.
 */
function listable(user) {
  return user?.type === "User" && user.login !== "ghost" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user.login)
    && typeof user.avatar_url === "string" && user.avatar_url.startsWith("https://avatars.githubusercontent.com/");
}

/** An issue labelled this way does not put its author in the list. */
const skipLabel = "spam";

/** One entry per person: the owner first, then by commits, then by issues opened. */
export function people({ owner, contributors, issues }) {
  const byLogin = new Map();
  const person = (user) => {
    if (!byLogin.has(user.login)) byLogin.set(user.login, { login: user.login, avatar: user.avatar_url, commits: 0, reports: 0, maintainer: user.login === owner });
    return byLogin.get(user.login);
  };
  for (const user of contributors) if (listable(user)) person(user).commits = user.contributions;
  // The issues list carries pull requests too; those are already counted as commits.
  for (const issue of issues) {
    if (issue.pull_request || !listable(issue.user) || issue.labels?.some((label) => label.name === skipLabel)) continue;
    person(issue.user).reports++;
  }
  return [...byLogin.values()].sort((a, b) =>
    Number(b.maintainer) - Number(a.maintainer) || b.commits - a.commits || b.reports - a.reports || a.login.localeCompare(b.login));
}

/** A picture and a name for each person; the counts only set the order. */
export function renderPeople(list) {
  const cell = (p) => {
    const avatar = `${p.avatar}${p.avatar.includes("?") ? "&" : "?"}s=128`;
    return `    <td align="center" valign="top" width="120"><img src="${avatar}" width="64" height="64" alt="" /><br /><b>${p.login}</b></td>`;
  };
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) rows.push(`  <tr>\n${list.slice(i, i + perRow).map(cell).join("\n")}\n  </tr>`);
  return `<table>\n${rows.join("\n")}\n</table>`;
}

/** A picture's file name under public/people, by the kind of image GitHub sent. */
export function pictureName(login, contentType) {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[String(contentType).split(";")[0].trim()];
  if (!ext) throw new Error(`GitHub sent ${contentType} for ${login}'s picture`);
  return `${login}.${ext}`;
}

/** Every letter the thanks line takes in any language, once each, in a fixed order so the font changes only with the words. */
export function thanksLetters(texts) {
  return [...new Set([...texts.join("")])].sort().join("");
}

/** Puts `body` between the markers, keeping the markers and everything around them.
 * A Windows checkout has CRLF line ends, and the body takes the file's own. */
export function replaceSection(text, body) {
  const match = /(<!-- people:start -->(\r?\n))[\s\S]*?(<!-- people:end -->)/.exec(text);
  if (!match) throw new Error("The README has no people:start / people:end markers");
  const eol = match[2];
  return text.slice(0, match.index) + match[1] + body.replace(/\n/g, eol) + eol + match[3] + text.slice(match.index + match[0].length);
}

async function github(path) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers = { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const all = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${path}`);
    const items = await response.json();
    all.push(...items);
    if (items.length < 100) return all;
  }
}

async function download(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response;
}

/** The app shows the same people offline, so their pictures ship with it: 96 px for a 32 px face on a 3x screen. */
async function writeAppList(list) {
  mkdirSync(pictures, { recursive: true });
  const entries = [];
  for (const p of list) {
    const response = await download(`${p.avatar}${p.avatar.includes("?") ? "&" : "?"}s=96`);
    const name = pictureName(p.login, response.headers.get("content-type"));
    writeFileSync(resolve(pictures, name), Buffer.from(await response.arrayBuffer()));
    entries.push({ login: p.login, picture: `people/${name}` });
  }
  for (const file of readdirSync(pictures)) if (!entries.some((e) => e.picture === `people/${file}`)) rmSync(resolve(pictures, file));
  writeFileSync(appList, `${JSON.stringify(entries, null, 2)}\n`);
}

/** Caveat for the thanks line, holding only its letters in every language the app has: a few kilobytes, not a hundred. */
async function writeThanksFont() {
  const texts = readdirSync(i18n, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(resolve(i18n, entry.name, "radio.json"), "utf8"))["people.thanks"])
    .filter(Boolean);
  const css = await (await download(`https://fonts.googleapis.com/css2?family=Caveat:wght@500&text=${encodeURIComponent(thanksLetters(texts))}`, { "user-agent": browser })).text();
  const url = /url\((https:[^)]+)\)\s*format\('woff2'\)/.exec(css)?.[1];
  if (!url) throw new Error("Google Fonts sent no WOFF2 for the thanks line");
  writeFileSync(thanksFont, Buffer.from(await (await download(url)).arrayBuffer()));
}

export async function main() {
  const [contributors, issues] = await Promise.all([github("contributors"), github("issues?state=all")]);
  const list = people({ owner: repository.split("/")[0], contributors, issues });
  const table = renderPeople(list);
  for (const file of ["README.md", "README.ru.md"]) {
    const path = resolve(root, file);
    writeFileSync(path, replaceSection(readFileSync(path, "utf8"), table));
  }
  await writeAppList(list);
  await writeThanksFont();
  console.log(list.map((p) => p.login).join("\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
