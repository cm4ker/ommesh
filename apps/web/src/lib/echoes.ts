import { AdvType, type ContactRecord, type MessageEcho } from "@meshnet/meshcore";

export interface Relay {
  /** The hash the node signs the path with: the first bytes of its key, hex. */
  hash: string;
  /** Its name when exactly one contact's key starts with the hash. */
  name: string | null;
}

/** Every node that relayed the message, in the order they first appear in the echoes heard. */
export function relaysOf(echoes: MessageEcho[], contacts: Record<string, ContactRecord>): Relay[] {
  const seen = new Map<string, Relay>();
  for (const echo of echoes) {
    for (const hash of echo.path) {
      if (!seen.has(hash)) seen.set(hash, { hash, name: nameOfHash(hash, contacts) });
    }
  }
  return [...seen.values()];
}

/**
 * The contacts a path hash could be: those whose key starts with it, the
 * repeaters and rooms among them when there are any, since only they relay.
 * With one-byte hashes on a busy mesh there are often several. `not` is the
 * node a route leads to, which is never a relay on its own way.
 */
export function candidatesOfHash(hash: string, contacts: Record<string, ContactRecord>, not?: string): ContactRecord[] {
  const all = Object.values(contacts).filter((c) => c.key.startsWith(hash) && c.key !== not);
  const relaying = all.filter((c) => c.type === AdvType.Repeater || c.type === AdvType.Room);
  return relaying.length > 0 ? relaying : all;
}

/** How far a message spread, from the copies of it heard back. */
export interface Spread {
  /** The relays that heard the sender itself, loudest first: how loud each one's own copy was here, null when only copies from further on were heard. */
  first: { hash: string; snr: number | null }[];
  /** The relays further on, in the order first heard of. */
  further: string[];
  /** The most relays any copy came through. */
  farthest: number;
  /** The paths of the copies that came through more than one relay. */
  chains: string[][];
}

/**
 * The copies of a message heard back, as who sent it on: first the relays
 * that heard the sender, then the rest. A repeater sends a flood on once,
 * so each relay is counted once, wherever it shows up.
 */
export function spreadOf(echoes: MessageEcho[]): Spread {
  const first = new Map<string, number | null>();
  const further: string[] = [];
  const chains: string[][] = [];
  let farthest = 0;
  for (const echo of echoes) {
    const [head, ...rest] = echo.path;
    if (head === undefined) continue;
    if (!first.has(head)) first.set(head, null);
    if (rest.length === 0) first.set(head, Math.max(first.get(head) ?? -Infinity, echo.snr));
    else chains.push(echo.path);
    for (const hash of rest) if (!further.includes(hash)) further.push(hash);
    farthest = Math.max(farthest, echo.path.length);
  }
  const loudness = (snr: number | null) => (snr === null ? -Infinity : snr);
  return {
    first: [...first].map(([hash, snr]) => ({ hash, snr })).sort((a, b) => loudness(b.snr) - loudness(a.snr)),
    further: further.filter((hash) => !first.has(hash)),
    farthest,
    chains,
  };
}

export function nameOfHash(hash: string, contacts: Record<string, ContactRecord>, not?: string): string | null {
  const matches = candidatesOfHash(hash, contacts, not);
  return matches.length === 1 ? matches[0]!.name : null;
}
