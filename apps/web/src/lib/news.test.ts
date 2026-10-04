import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { arrival, fixes, getNews, newThings, parseRelease, registerNews, showTarget, thingWords, type Release } from "./news.js";
import { getNewBuild, heard } from "./newBuild.js";

/** A news file as it is written. */
const file = (version: string, kinds: ("new" | "fix")[] = ["new", "fix"]) => ({
  version,
  date: "2026-10-08",
  items: kinds.map((kind) => (kind === "new" ? { kind, en: { title: `New in ${version}`, text: "It is here." }, ru: { title: `Новое в ${version}`, text: "Оно здесь." } } : { kind, en: "Fixed.", ru: "Исправлено." })),
});
const release = (version: string, kinds?: ("new" | "fix")[]): Release => parseRelease(file(version, kinds))!;

const dir = new URL("../news/", import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as { items: unknown[] });

test("every news file the app carries reads whole, and its Show buttons lead somewhere", () => {
  assert.ok(files.length > 0);
  for (const file of files) {
    const parsed = parseRelease(file);
    assert.ok(parsed, "a news file does not read");
    assert.equal(parsed.items.length, file.items.length, `${parsed.version}: an item was left out`);
    for (const item of newThings(parsed)) {
      if (item.show !== null) assert.ok(showTarget(item.show), `${parsed.version}: "${item.show}" is no place in the app`);
    }
  }
});

test("a feed's news are read with care: what is malformed is left out", () => {
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease({ version: "0.7", date: "2026-10-08", items: [] }), null);
  assert.equal(parseRelease({ version: "0.7.0", date: "2026-10-08", items: [{ kind: "new", ru: { title: "Только по-русски", text: "." } }] }), null);
  const parsed = parseRelease({
    version: "0.7.0",
    date: "2026-10-08",
    items: [{ kind: "new", show: 5, en: { title: "Pins", text: "Pin a chat." }, de: "kaputt" }, { kind: "later" }, "nothing", { kind: "fix", en: "Fixed.", ru: 7 }],
  })!;
  assert.deepEqual(parsed.items, [
    { kind: "new", show: null, words: { en: { title: "Pins", text: "Pin a chat." } } },
    { kind: "fix", words: { en: "Fixed." } },
  ]);
  assert.equal(thingWords(newThings(parsed)[0]!).title, "Pins");
  assert.equal(fixes(parsed).length, 1);
});

test("an update shows what it brought; a first install and fixes alone put up no strip", () => {
  const list = [release("0.9.0"), release("0.8.0"), release("0.7.0")];
  // Updated from 0.7.0: both later versions are open, and the strip waits until it is opened or closed.
  assert.deepEqual(arrival(list, "0.7.0", true), { fresh: ["0.9.0", "0.8.0"], strip: true, seen: null });
  assert.deepEqual(arrival(list, "0.9.0", true), { fresh: [], strip: false, seen: null });
  // From a build before news: the newest version, once.
  assert.deepEqual(arrival(list, null, true), { fresh: ["0.9.0"], strip: true, seen: null });
  // A first install has seen nothing, so nothing is new to it.
  assert.deepEqual(arrival(list, null, false), { fresh: [], strip: false, seen: "0.9.0" });
  const fixesOnly = [release("0.9.1", ["fix"]), ...list];
  assert.deepEqual(arrival(fixesOnly, "0.9.0", true), { fresh: ["0.9.1"], strip: false, seen: "0.9.1" });
  assert.deepEqual(arrival(fixesOnly, "0.8.0", true), { fresh: ["0.9.1", "0.9.0"], strip: true, seen: null });
  assert.deepEqual(arrival([], "0.8.0", true), { fresh: [], strip: false, seen: null });
});

test("a build carries the news of its own version and earlier ones, newest first", () => {
  const files = [file("0.7.0"), file("0.9.0"), file("0.8.0")];
  registerNews(files, "0.8.0-dev.300.1", "0.7.0", true);
  assert.deepEqual(getNews().releases.map((r) => r.version), ["0.8.0", "0.7.0"]);
  assert.deepEqual(getNews().fresh, ["0.8.0"]);
  assert.equal(getNews().strip, true);
  registerNews(files, "0.9.0", "0.9.0", true);
  assert.equal(getNews().strip, false);
});

test("Show leads to a section or a page of Settings, nowhere else", () => {
  assert.ok(showTarget("mesh"));
  assert.ok(showTarget("radio/frequency"));
  assert.equal(showTarget("radio/nowhere"), null);
  assert.equal(showTarget("map"), null);
});

test("an APK hears a version's news only when this build does not carry them", () => {
  const news = { version: "0.8.0", date: "2026-10-15", items: [{ kind: "new", en: { title: "Pins", text: "Pin a chat." } }] };
  heard("0.8.0", "0.7.0", 0, news);
  assert.equal(getNewBuild().news?.version, "0.8.0");
  // A Dev build on its way to 0.8.0 carries the file already.
  heard("0.8.0-dev.310.1", "0.8.0-dev.300.1", 0, news);
  assert.equal(getNewBuild().latest, "0.8.0-dev.310.1");
  assert.equal(getNewBuild().news, null);
  heard("0.7.0", "0.7.0", 0, news);
  assert.equal(getNewBuild().news, null);
});
