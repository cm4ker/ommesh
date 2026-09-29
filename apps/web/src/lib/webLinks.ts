/**
 * Web addresses in a message, which open in the system's browser with a tap.
 * Only what is plainly an address counts: one with http:// or https://, or
 * one that starts with www. A bare "meshcore.io" is left as text, since a
 * version such as v1.17.1 would read the same way.
 */

import { invoke } from "@tauri-apps/api/core";
import { errorText } from "../i18n/errors.js";
import { shell } from "./platform.js";
import { toast } from "./toast.js";

/** An address as typed, up to the next space. A phone writes the first letter of a message as a capital. */
export const LINK = /(?:[Hh]ttps?:\/\/|[Ww]ww\.)[^\s<>"«»]+/g;

const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * The address a match of `LINK` stands for, without the punctuation of the
 * sentence around it, and where it leads; null when nothing is left past the
 * "www." or the scheme. A closing bracket stays when the address opened one,
 * as a Wikipedia page's title does.
 */
export function linkOf(match: string): { text: string; href: string } | null {
  let text = match;
  for (;;) {
    const last = text.at(-1)!;
    const open = PAIRS[last];
    if (".,;:!?'…".includes(last) || (open !== undefined && count(text, open) < count(text, last))) text = text.slice(0, -1);
    else break;
  }
  const scheme = /^[Hh]ttps?:\/\//.test(text);
  if (text.length <= (scheme ? text.indexOf("//") + 2 : 4)) return null;
  return { text, href: scheme ? text : `https://${text}` };
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Opens an address in the system's browser. The desktop asks its shell to; a
 * phone's shell hands a page's way off its own host to the phone's browser,
 * and a browser opens a tab.
 */
export function openLink(href: string): void {
  if (shell() === "tauri") {
    invoke("plugin:opener|open_url", { url: href }).catch((error: unknown) => toast(errorText(error), "error"));
    return;
  }
  window.open(href, "_blank", "noopener");
}
