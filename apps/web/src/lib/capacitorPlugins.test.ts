import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/*
 * A Capacitor plugin from `registerPlugin` is a proxy that answers every
 * name with a native method, `then` too. A promise resolved with it takes it
 * for a promise and waits on the phone for ever, with no error; the browser
 * never loads the plugin, so no other test sees it. The plugin is handed into
 * a callback instead (`withShare`, `withRelay`, `withGeo`).
 */

const src = new URL("../", import.meta.url);
const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

test("no promise is resolved with a Capacitor plugin", () => {
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file.replaceAll("\\", "/"), src), "utf8");
    // A function that gives a plugin back through its promise, or a `then` that returns one.
    for (const m of text.matchAll(/Promise<\w*Plugin>|=>\s*registerPlugin\b/g)) found.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(found, [], "hand the plugin into a callback instead");
});
