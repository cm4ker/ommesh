/**
 * Link previews come from the Ommesh project's preview server
 * (preview.cm4ker.ru, its own repository, ommesh-preview). The server visits
 * the link, not this device: a stranger who writes a link learns nothing of
 * its readers and can reach nothing of theirs, and a picture arrives as one
 * the server encoded anew. The server keeps each answer for a day, so a link
 * many readers see is visited once. Only the link's address leaves the
 * device, by HTTPS, with no cookies and no referrer.
 */

export const PREVIEW_SERVER = "https://preview.cm4ker.ru";

/** A preview as the server answers it; see the server's README. */
export interface Answered {
  kind: "page" | "picture" | "file" | "none";
  host: string;
  title: string;
  description: string;
  large: boolean;
  video: boolean;
  duration: number | null;
  file: { name: string; size: number | null; mark: string } | null;
  image: { type: string; width: number; height: number; data: string } | null;
}

/** Why there is no preview: `address`, `redirects`, `status 404`, `timeout`, `network`, or `busy` when this address asked too fast. */
export class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The server's preview of `href`. Throws `Refused`. */
export async function askPreview(href: string): Promise<Answered> {
  let response: Response;
  try {
    response = await fetch(`${PREVIEW_SERVER}/v1/preview?url=${encodeURIComponent(href)}`, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Refused(error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network");
  }
  if (response.status === 429) throw new Refused("busy");
  if (!response.ok) throw new Refused("network");
  const answer = (await response.json().catch(() => null)) as (Answered & { refused?: string }) | null;
  if (!answer) throw new Refused("network");
  if (typeof answer.refused === "string") throw new Refused(answer.refused);
  return answer;
}
