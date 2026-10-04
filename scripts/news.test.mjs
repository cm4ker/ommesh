import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { baseVersion, compareStable, githubBody, LIMITS, listReleases, playText, problems, storeText, telegramText, updaterNotes, writePlayNotes } from "./news.mjs";

const release = {
  version: "0.9.0",
  date: "2026-10-22",
  items: [
    { kind: "new", show: "radio/frequency", en: { title: "Repeat beside the frequency", text: "Your radio can pass on messages." }, ru: { title: "Ретрансляция рядом с частотой", text: "Радио может передавать сообщения дальше." } },
    { kind: "new", en: { title: "Is it here?", text: "It is." }, ru: { title: "Оно здесь?", text: "Здесь." } },
    { kind: "fix", en: "Apply no longer turns repeat off.", ru: "«Применить» больше не выключает ретрансляцию." },
  ],
};

test("every news file in the app is right", () => {
  const files = listReleases();
  assert.ok(files.length > 0, "apps/web/src/news has no files");
  for (const { name, release } of files) assert.deepEqual(problems(release, name), []);
});

test("news files are listed newest first", () => {
  const versions = listReleases().map(({ release }) => release.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => compareStable(b, a)));
  assert.equal(compareStable("0.10.0", "0.9.9"), 1);
  assert.equal(baseVersion("0.7.0-dev.250.1"), "0.7.0");
});

test("a news file is checked for what a reader would miss", () => {
  const item = (patch) => ({ ...release, items: [{ ...release.items[0], ...patch }] });
  assert.deepEqual(problems(release, "0.9.0.json"), []);
  assert.match(problems(release, "0.8.0.json").join(), /named 0\.9\.0\.json/);
  assert.match(problems({ ...release, version: "0.9" }).join(), /X\.Y\.Z/);
  assert.match(problems({ ...release, date: "22.10.2026" }).join(), /YYYY-MM-DD/);
  assert.match(problems({ ...release, items: [] }).join(), /items/);
  assert.match(problems(item({ ru: undefined })).join(), /no ru title/);
  assert.match(problems(item({ en: { title: "x".repeat(LIMITS.title + 1), text: "y" } })).join(), /en title is 61/);
  assert.match(problems(item({ en: { title: "Ends with a stop.", text: "y" } })).join(), /full stop/);
  assert.match(problems(item({ en: { title: "Fine", text: "" } })).join(), /no en text/);
  assert.match(problems(item({ show: "radio" })).join(), /show must be/);
  assert.match(problems(item({ shows: "mesh" })).join(), /unknown field "shows"/);
  assert.match(problems({ ...release, items: [{ kind: "fix", en: "Fixed." }] }).join(), /no ru line/);
  assert.match(problems({ ...release, items: [{ kind: "later", en: "x", ru: "x" }] }).join(), /kind/);
  const six = Array.from({ length: 6 }, () => release.items[1]);
  assert.match(problems({ ...release, items: six }).join(), /6 new things/);
  const long = Array.from({ length: 4 }, () => ({ kind: "fix", en: "x".repeat(150), ru: "x" }));
  assert.match(problems({ ...release, items: long }).join(), /Google Play's en text is \d+ characters, over 500/);
});

test("the feed's notes carry both languages, for desktop clients that show them as they are", () => {
  assert.equal(updaterNotes(release), "• Repeat beside the frequency\n• Is it here?\nFixed: 1\n\n• Ретрансляция рядом с частотой\n• Оно здесь?\nИсправлено: 1");
});

test("the texts for GitHub, the stores and Telegram", () => {
  const body = githubBody(release);
  assert.ok(body.indexOf("## What's new") < body.indexOf("## Что нового"));
  assert.match(body, /^- \*\*Repeat beside the frequency\.\*\* Your radio can pass on messages\.$/m);
  assert.match(body, /^- \*\*Is it here\?\*\* It is\.$/m);
  assert.match(body, /\(https:\/\/github\.com\/cm4ker\/ommesh\/blob\/v0\.9\.0\/CHANGELOG\.ru\.md\)$/);
  assert.equal(playText(release, "en"), "• Repeat beside the frequency.\n• Is it here?\n• Apply no longer turns repeat off.");
  assert.equal(storeText(release, "ru"), "Ретрансляция рядом с частотой. Радио может передавать сообщения дальше.\n\nОно здесь? Здесь.\n\nИсправлено:\n• «Применить» больше не выключает ретрансляцию.");
  const post = telegramText(release, "ru");
  assert.ok(post.startsWith("**Ommesh 0.9.0** — что нового\n\n• **Ретрансляция рядом с частотой.**"));
  assert.ok(post.endsWith("https://github.com/cm4ker/ommesh/releases/tag/v0.9.0"));
  const fixesOnly = { ...release, items: [release.items[2]] };
  assert.equal(storeText(fixesOnly, "en"), "Fixed:\n• Apply no longer turns repeat off.");
  assert.equal(updaterNotes(fixesOnly), "Fixed: 1\n\nИсправлено: 1");
});

test("Play gets a whatsnew file per store language", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "meshnet-news-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith("meshnet-news-test-"));
    rmSync(directory, { recursive: true });
  });
  writePlayNotes(release, directory);
  assert.equal(readFileSync(join(directory, "whatsnew-en-GB"), "utf8"), `${playText(release, "en")}\n`);
  assert.equal(readFileSync(join(directory, "whatsnew-ru-RU"), "utf8"), `${playText(release, "ru")}\n`);
});
