/**
 * What a version brings, said once and shown everywhere. Each stable version
 * has a file in apps/web/src/news, named by the version: up to five new
 * things, each a title and a sentence or two, and the fixes, a line each, in
 * English and Russian. The app carries the files and shows them after an
 * update; this script turns one into the texts for everywhere else: the notes
 * in the desktop feed, the GitHub release, Google Play's "What's new", the
 * App Store and TestFlight, and a post for Telegram. CHANGELOG.md stays the
 * full account; a news file is what a person reads in a minute.
 *
 *   pnpm news [version]       prints the App Store and Telegram texts
 *   pnpm news play <dir>      writes Play's whatsnew files for package.json's version
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const NEWS_DIR = resolve(root, "apps/web/src/news");
export const REPOSITORY = "cm4ker/ommesh";

/** Every news item is in each of these; a language the app gains later may be added beside them. */
export const LANGUAGES = ["en", "ru"];
export const LIMITS = { news: 5, title: 60, text: 200, fix: 200, play: 500 };

const WORDS = {
  en: { news: "What's new", fixed: "Fixed", get: "Get it: Google Play, App Store, Windows and the Android APK" },
  ru: { news: "Что нового", fixed: "Исправлено", get: "Обновиться: Google Play, App Store, Windows и APK для Android" },
};

const STABLE = /^\d+\.\d+\.\d+$/;
const SHOW = /^(?:chats|mesh|radio\/[a-z][a-zA-Z]*)$/;
const LANGUAGE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/** A title as the start of a sentence: a full stop after it unless it ends in its own mark. */
const sentence = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const news = (release) => release.items.filter((item) => item.kind === "new");
const fixes = (release) => release.items.filter((item) => item.kind === "fix");

/** The X.Y.Z of a version, a Dev build's prerelease part left off. */
export function baseVersion(version) {
  return version.split(/[-+]/)[0];
}

/** X.Y.Z against X.Y.Z, by number. */
export function compareStable(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}

/** The news of one version, or null when it has none. */
export function readRelease(version, dir = NEWS_DIR) {
  const path = resolve(dir, `${version}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** Every news file, newest version first, with the name it was read from. */
export function listReleases(dir = NEWS_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, release: JSON.parse(readFileSync(resolve(dir, name), "utf8")) }))
    .sort((a, b) => compareStable(String(b.release.version), String(a.release.version)));
}

/** What is wrong with a news file, as lines to fix; none when it is right. */
export function problems(release, name) {
  const found = [];
  const say = (text) => found.push(name ? `${name}: ${text}` : text);
  if (!release || typeof release !== "object") return [`${name ?? "news"}: not an object`];
  if (typeof release.version !== "string" || !STABLE.test(release.version)) say(`version must be X.Y.Z, not ${JSON.stringify(release.version)}`);
  else if (name && name !== `${release.version}.json`) say(`the file must be named ${release.version}.json`);
  if (typeof release.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(release.date) || Number.isNaN(Date.parse(release.date))) say("date must be YYYY-MM-DD");
  if (!Array.isArray(release.items) || release.items.length === 0) return [...found, `${name ?? "news"}: items must list what changed`];
  release.items.forEach((item, i) => {
    const at = `item ${i + 1}`;
    if (item?.kind !== "new" && item?.kind !== "fix") return say(`${at}: kind must be "new" or "fix"`);
    for (const key of Object.keys(item)) {
      if (key !== "kind" && !(key === "show" && item.kind === "new") && !LANGUAGE.test(key)) say(`${at}: unknown field "${key}"`);
    }
    for (const lang of LANGUAGES) {
      const words = item[lang];
      if (item.kind === "fix") {
        if (typeof words !== "string" || !words.trim()) say(`${at}: no ${lang} line`);
        else if (words.length > LIMITS.fix) say(`${at}: the ${lang} line is ${words.length} characters, over ${LIMITS.fix}`);
        continue;
      }
      if (!words || typeof words.title !== "string" || !words.title.trim()) say(`${at}: no ${lang} title`);
      else if (words.title.length > LIMITS.title) say(`${at}: the ${lang} title is ${words.title.length} characters, over ${LIMITS.title}`);
      else if (words.title.endsWith(".")) say(`${at}: the ${lang} title ends with a full stop`);
      if (!words || typeof words.text !== "string" || !words.text.trim()) say(`${at}: no ${lang} text`);
      else if (words.text.length > LIMITS.text) say(`${at}: the ${lang} text is ${words.text.length} characters, over ${LIMITS.text}`);
    }
    if (item.kind === "new" && item.show !== undefined && (typeof item.show !== "string" || !SHOW.test(item.show))) say(`${at}: show must be chats, mesh or radio/<page>`);
  });
  if (news(release).length > LIMITS.news) say(`${news(release).length} new things, more than ${LIMITS.news}: leave the rest to CHANGELOG.md`);
  if (found.length === 0) {
    for (const lang of LANGUAGES) {
      const length = playText(release, lang).length;
      if (length > LIMITS.play) say(`Google Play's ${lang} text is ${length} characters, over ${LIMITS.play}: shorten the titles or the fixes`);
    }
  }
  return found;
}

/** The notes in the desktop feed. A client before 0.7.0 shows them as they are, so both languages go in. */
export function updaterNotes(release) {
  return LANGUAGES.map((lang) => {
    const lines = news(release).map((item) => `• ${item[lang].title}`);
    const fixed = fixes(release).length;
    if (fixed) lines.push(`${WORDS[lang].fixed}: ${fixed}`);
    return lines.join("\n");
  }).join("\n\n");
}

/** The GitHub release's page, English and then Russian. */
export function githubBody(release, repository = REPOSITORY) {
  const part = (lang, changelog) => {
    const words = WORDS[lang];
    const lines = [];
    if (news(release).length) lines.push(`## ${words.news}`, "", ...news(release).map((item) => `- **${sentence(item[lang].title)}** ${item[lang].text}`), "");
    if (fixes(release).length) lines.push(`## ${words.fixed}`, "", ...fixes(release).map((item) => `- ${item[lang]}`), "");
    lines.push(`[${changelog}](https://github.com/${repository}/blob/v${release.version}/${changelog})`);
    return lines.join("\n");
  };
  return `${part("en", "CHANGELOG.md")}\n\n---\n\n${part("ru", "CHANGELOG.ru.md")}`;
}

/** Google Play's "What's new": a line a thing, 500 characters a language at most. */
export function playText(release, lang) {
  return [...news(release).map((item) => `• ${sentence(item[lang].title)}`), ...fixes(release).map((item) => `• ${item[lang]}`)].join("\n");
}

/** The App Store's "What's New" and TestFlight's "What to Test": plain text, no markup. */
export function storeText(release, lang) {
  const parts = news(release).map((item) => `${sentence(item[lang].title)} ${item[lang].text}`);
  if (fixes(release).length) parts.push(`${WORDS[lang].fixed}:\n${fixes(release).map((item) => `• ${item[lang]}`).join("\n")}`);
  return parts.join("\n\n");
}

/** A post for Telegram, with the bold Telegram makes of ** when it is pasted in. */
export function telegramText(release, lang, repository = REPOSITORY) {
  const words = WORDS[lang];
  const parts = [`**Ommesh ${release.version}** — ${words.news.toLowerCase()}`];
  parts.push(...news(release).map((item) => `• **${sentence(item[lang].title)}** ${item[lang].text}`));
  if (fixes(release).length) parts.push(`${words.fixed}:\n${fixes(release).map((item) => `— ${item[lang]}`).join("\n")}`);
  parts.push(`${words.get}:\nhttps://github.com/${repository}/releases/tag/v${release.version}`);
  return parts.join("\n\n");
}

/** Play's whatsnew files for one version, by the store's language codes. */
export function writePlayNotes(release, directory) {
  mkdirSync(directory, { recursive: true });
  for (const [file, lang] of [["whatsnew-en-US", "en"], ["whatsnew-en-GB", "en"], ["whatsnew-ru-RU", "ru"]]) {
    writeFileSync(resolve(directory, file), `${playText(release, lang)}\n`);
  }
}

function needRelease(version) {
  const release = readRelease(version);
  if (!release) throw new Error(`No apps/web/src/news/${version}.json: write what ${version} brings first`);
  const wrong = problems(release, `${version}.json`);
  if (wrong.length) throw new Error(wrong.join("\n"));
  return release;
}

export function main(args) {
  const version = baseVersion(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version);
  if (args[0] === "play") {
    if (!args[1]) throw new Error("Usage: node scripts/news.mjs play <directory>");
    writePlayNotes(needRelease(version), resolve(args[1]));
    return;
  }
  const release = needRelease(args[0] ?? version);
  for (const lang of LANGUAGES) {
    console.log(`==== App Store "What's New" and TestFlight "What to Test" · ${lang}\n\n${storeText(release, lang)}\n`);
  }
  for (const lang of LANGUAGES) {
    console.log(`==== Telegram · ${lang}\n\n${telegramText(release, lang)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
