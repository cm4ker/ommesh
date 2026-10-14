import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

/*
 * The stylesheets keep three rules a reader cannot see from any one file:
 * styles.css imports every file in styles/ once, no file names a colour of its
 * own (colour comes from the theme's tokens, theme/themes.ts), and no rule is
 * left for a class nothing in the app uses any more.
 */

const root = new URL("./", import.meta.url);
const index = readFileSync(new URL("styles.css", root), "utf8");
const imported = [...index.matchAll(/@import "\.\/styles\/([\w-]+\.css)";/g)].map((m) => m[1]!);
const sheets = readdirSync(new URL("styles/", root)).filter((f) => f.endsWith(".css"));
const read = (file: string) => readFileSync(new URL(`styles/${file}`, root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("styles.css imports every stylesheet in styles/, each once", () => {
  assert.deepEqual([...imported].sort(), [...sheets].sort());
  assert.equal(new Set(imported).size, imported.length, "a file is imported twice");
});

/** A value's colour of its own: a hex code, channels written out, or a colour's name. */
const COLOUR = [
  /#[0-9a-f]{3,8}\b/i,
  /\b(?:rgba?|hsla?|hwb|lab|lch)\(\s*[\d.]/i,
  /(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![\w-])/i,
];

test("no stylesheet names a colour; the theme's tokens give them all", () => {
  const found: string[] = [];
  for (const file of sheets) {
    // A declaration's value runs from its colon to the semicolon or brace; a selector's colons meet a brace first.
    for (const m of read(file).matchAll(/([\w-]+)\s*:\s*([^;{}]*)(?=[;}])/g)) {
      const value = m[2]!;
      if (COLOUR.some((re) => re.test(value))) found.push(`${file}: ${m[1]}: ${value.trim()}`);
    }
  }
  assert.deepEqual(found, [], "use a token from theme/themes.ts instead");
});

function sources(dir: URL, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = new URL(name, dir);
    if (statSync(path).isDirectory()) sources(new URL(`${name}/`, dir), out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) out.push(readFileSync(path, "utf8"));
  }
  return out;
}

test("every class a stylesheet styles is used somewhere in the app", () => {
  const code = [...sources(root), readFileSync(new URL("../index.html", root), "utf8"), readFileSync(new URL("../notices.html", root), "utf8")].join("\n");
  const words = new Set(code.match(/[\w-]+/g));
  // Made in code from a stem and a value (`kind-${e.kind}`), or put on by the map library.
  const built = (name: string) =>
    name.startsWith("maplibregl-") ||
    name
      .split("-")
      .slice(0, -1)
      .some((_, i, parts) => {
        const stem = `${parts.slice(0, i + 1).join("-")}-`;
        return code.includes(`${stem}\${`) || code.includes(`"${stem}" +`);
      });
  const unused = new Set<string>();
  for (const file of sheets) {
    // Only the selectors: what lies inside braces is dropped, innermost first, so 0.5 or a url's dots never count.
    let text = read(file);
    for (let before = ""; before !== text; ) {
      before = text;
      text = text.replace(/\{[^{}]*\}/g, ";");
    }
    for (const m of text.matchAll(/\.([a-z_][\w-]*)/gi)) if (!words.has(m[1]!) && !built(m[1]!)) unused.add(`${file}: .${m[1]}`);
  }
  assert.deepEqual([...unused], [], "remove the rules, or use the class");
});
