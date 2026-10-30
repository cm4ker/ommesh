/**
 * Formulas typed between `$$` (lib/textFormat.ts), drawn by KaTeX. KaTeX and its stylesheet are
 * a chunk of their own, fetched the first time a chat shows a formula: few people ever send one,
 * and the client starts no slower for it. Until it comes, and where KaTeX cannot read a
 * formula, the formula shows as typed. A formula on a line of its own is drawn as TeX draws
 * one, in a `katex-display` of its own.
 */

import type { KatexOptions } from "katex";

type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/**
 * A formula comes from whoever sent it, so nothing in it may reach out (`trust: false` keeps
 * `\href`, `\includegraphics` and the HTML commands off), grow past a few lines' height or
 * expand its macros for ever.
 */
const OPTIONS: KatexOptions = { throwOnError: true, trust: false, strict: "ignore", maxSize: 10, maxExpand: 1000 };

/** What each formula drew as, by its TeX; null where KaTeX could not read it. */
const drawn = new Map<string, string | null>();

export function formulasReady(): boolean {
  return katex !== null;
}

export function onFormulas(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fetches KaTeX once; a failed fetch is tried again the next time a formula is shown. */
export function loadFormulas(): void {
  loading ??= import("./formulaChunk.js").then(
    (chunk) => {
      katex = chunk.default;
      for (const listener of listeners) listener();
    },
    () => {
      loading = null;
    },
  );
}

/** The formula as KaTeX's HTML, or null while KaTeX is not here or cannot read it. */
export function formulaHtml(tex: string, display: boolean): string | null {
  if (!katex) return null;
  const key = `${display ? "d" : "i"}${tex}`;
  const known = drawn.get(key);
  if (known !== undefined) return known;
  let html: string | null = null;
  try {
    html = katex.renderToString(tex, { ...OPTIONS, displayMode: display });
  } catch {
    // A ParseError: the sender's TeX is wrong, or uses what KaTeX does not know.
  }
  if (drawn.size >= 500) drawn.clear();
  drawn.set(key, html);
  return html;
}
