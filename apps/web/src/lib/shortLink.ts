/**
 * A link too long for a message, shortened through the preview server: the
 * same server that draws previews keeps an address for a day and answers with
 * six letters (#118), `preview.cm4ker.ru/x1jpy2`.
 *
 * A short link lives a day, and the app says so where it offers one: it is for
 * today's chat, not for what a reader will open next week. Only the address
 * leaves the device, and only when the reader asks for it.
 */

import { PREVIEW_SERVER } from "./linkFetch.js";
import { LINK, linkOf } from "./webLinks.js";

export interface LongLink {
  /** The address as it stands in the text, without the punctuation around it. */
  text: string;
  href: string;
  /** Where it begins in the text, so it can be put back short. */
  at: number;
}

/** The longest address in a message, the one worth shortening; null when there is none. */
export function longestLink(text: string): LongLink | null {
  let found: LongLink | null = null;
  for (const match of text.matchAll(LINK)) {
    const link = linkOf(match[0]);
    if (!link) continue;
    const at = match.index ?? 0;
    if (!found || link.text.length > found.text.length) found = { text: link.text, href: link.href, at };
  }
  return found;
}

/** Why a link was not shortened: `address`, `bad-request`, `origin`, `busy` or `network`. */
export class ShortRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ShortRefused";
  }
}

/** The address to put in a message instead: the preview server's short link. Throws `ShortRefused`. */
export async function shortenLink(href: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${PREVIEW_SERVER}/v1/shorten`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: href }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ShortRefused(error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network");
  }
  if (response.status === 429) throw new ShortRefused("busy");
  const answer = (await response.json().catch(() => null)) as { path?: string; refused?: string } | null;
  if (!answer) throw new ShortRefused("network");
  if (typeof answer.refused === "string") throw new ShortRefused(answer.refused);
  if (!response.ok || typeof answer.path !== "string" || !/^[a-z0-9]{4,12}$/.test(answer.path)) throw new ShortRefused("network");
  return `${PREVIEW_SERVER}/${answer.path}`;
}

/** A short link put in place of the long one. */
export function withShortLink(text: string, long: LongLink, short: string): string {
  return text.slice(0, long.at) + short + text.slice(long.at + long.text.length);
}
