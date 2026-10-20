// Writes apps/web/src/emoji/<lang>.json, the emoji a reaction can be chosen
// from, with their names in each of the app's languages, from emojibase-data
// (Unicode's CLDR names). Run with `pnpm emoji` after updating emojibase-data
// or adding a language to the app.
//
// Each file names the emoji in its own language, and its search words hold
// the names and words of every language: people type the word that comes to
// them, which is not always in the language the app is set to.
//
// Only emoji up to Emoji 14 (2021) go in: a newer one shows as an empty box on
// the phones and computers that cannot draw it yet, and a reaction is seen by
// everyone in the channel. Flags stay out too, as Windows draws them as two
// letters, and so do the skin tones and the bare parts emoji are built from.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = new URL("../apps/web/src/emoji/", import.meta.url);
/** The app's languages: a folder each under apps/web/src/i18n. */
const langs = readdirSync(new URL("../apps/web/src/i18n/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const NEWEST = 14;

/** emojibase's groups that go in, by its number, under the name the app knows them by. */
const GROUPS = { 0: "faces", 1: "people", 3: "nature", 4: "food", 5: "travel", 6: "activity", 7: "objects", 8: "symbols" };

/**
 * An emoji as Unicode spells it fully qualified, which is how every app sends
 * it. emojibase's own `emoji` adds U+FE0F to some that need none (👍), and
 * its hexcode leaves it off some that need it (☺️): a single character drawn
 * as text by default takes it, and a sequence carries it where it belongs.
 */
function qualified(entry) {
  const points = entry.hexcode.split("-").map((h) => parseInt(h, 16));
  if (points.length === 1 && entry.type === 0) points.push(0xfe0f);
  return String.fromCodePoint(...points);
}

/** Every language's entries that go in, by hexcode, in Unicode's order. */
const data = Object.fromEntries(
  langs.map((lang) => [
    lang,
    new Map(
      require(`emojibase-data/${lang}/data.json`)
        .filter((entry) => GROUPS[entry.group] && entry.version <= NEWEST)
        .sort((a, b) => a.order - b.order)
        .map((entry) => [entry.hexcode, entry]),
    ),
  ]),
);

/** The words an emoji is found by in one language: its name's and its own. */
const wordsOf = (entry) => (entry ? [...entry.label.split(/\s+/), ...(entry.tags ?? [])] : []);

mkdirSync(root, { recursive: true });
for (const lang of langs) {
  const out = Object.fromEntries(Object.values(GROUPS).map((id) => [id, []]));
  for (const [hexcode, entry] of data[lang]) {
    const own = new Set(entry.label.toLowerCase().split(/\s+/));
    const words = new Set([...(entry.tags ?? []), ...langs.filter((other) => other !== lang).flatMap((other) => wordsOf(data[other].get(hexcode)))].map((w) => w.toLowerCase()));
    for (const word of own) words.delete(word);
    out[GROUPS[entry.group]].push([qualified(entry), entry.label, [...words].join(" ")]);
  }
  writeFileSync(new URL(`${lang}.json`, root), `${JSON.stringify(out)}\n`);
  const count = Object.values(out).reduce((n, items) => n + items.length, 0);
  console.log(`${lang}: ${count} emoji`);
}
