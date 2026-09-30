/**
 * Writes the People section at the end of both READMEs from GitHub: everyone
 * whose commits are on master and everyone who opened an issue. The section
 * sits between the `people:start` and `people:end` comments; the rest of each
 * README is left as it is. Run `pnpm people` when someone new turns up.
 * GH_TOKEN or GITHUB_TOKEN is used when set; the public API is enough without.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "cm4ker/ommesh";
const perRow = 6;

/** One entry per person: the owner first, then by commits, then by issues opened. */
export function people({ owner, contributors, issues }) {
  const byLogin = new Map();
  const person = (user) => {
    if (!byLogin.has(user.login)) byLogin.set(user.login, { login: user.login, avatar: user.avatar_url, commits: 0, reports: 0, maintainer: user.login === owner });
    return byLogin.get(user.login);
  };
  for (const user of contributors) if (user.type === "User") person(user).commits = user.contributions;
  // The issues list carries pull requests too; those are already counted as commits.
  for (const issue of issues) if (issue.user?.type === "User" && !issue.pull_request) person(issue.user).reports++;
  return [...byLogin.values()].sort((a, b) =>
    Number(b.maintainer) - Number(a.maintainer) || b.commits - a.commits || b.reports - a.reports || a.login.localeCompare(b.login));
}

const words = {
  en: { maintainer: "maintainer", code: "code", reports: (n) => `${n} ${n === 1 ? "report" : "reports"}` },
  ru: { maintainer: "автор", code: "код", reports: (n) => `${n} ${plural(n, "обращение", "обращения", "обращений")}` },
};

function plural(n, one, few, many) {
  const [ten, hundred] = [n % 10, n % 100];
  if (ten === 1 && hundred !== 11) return one;
  return ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many;
}

/** What a person did, one short line each, under their picture. */
export function roles(person, lang) {
  const w = words[lang];
  return [person.maintainer ? w.maintainer : person.commits ? w.code : null, person.reports ? w.reports(person.reports) : null].filter(Boolean);
}

export const role = (person, lang) => roles(person, lang).join(" · ");

export function renderPeople(list, lang) {
  const cell = (p) => {
    const avatar = `${p.avatar}${p.avatar.includes("?") ? "&" : "?"}s=128`;
    // GitHub draws <sub> with no line height, so a role that wrapped would overprint itself: one line each.
    const lines = roles(p, lang).map((line) => `<br /><sub>${line}</sub>`).join("");
    return `    <td align="center" valign="top" width="120"><a href="https://github.com/${p.login}"><img src="${avatar}" width="64" height="64" alt="" /><br /><b>${p.login}</b></a>${lines}</td>`;
  };
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) rows.push(`  <tr>\n${list.slice(i, i + perRow).map(cell).join("\n")}\n  </tr>`);
  return `<table>\n${rows.join("\n")}\n</table>`;
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

export async function main() {
  const [contributors, issues] = await Promise.all([github("contributors"), github("issues?state=all")]);
  const list = people({ owner: repository.split("/")[0], contributors, issues });
  for (const [file, lang] of [["README.md", "en"], ["README.ru.md", "ru"]]) {
    const path = resolve(root, file);
    writeFileSync(path, replaceSection(readFileSync(path, "utf8"), renderPeople(list, lang)));
  }
  console.log(list.map((p) => `${p.login}: ${role(p, "en")}`).join("\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
