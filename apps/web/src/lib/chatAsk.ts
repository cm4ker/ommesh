/**
 * Something asked of a chat from outside it: by the list of who writes in a
 * channel (#64), to name a person in the field ("mention") or to step through
 * only their messages ("from"); by another app's share (#88), to put what it
 * shared in the field ("share"). A chat opening takes what waits for it as it
 * mounts; one already open, as on the desktop, hears it.
 */

interface AskOfName {
  conversation: string;
  name: string;
  /** For "from": our own messages, written under that name. */
  mine?: boolean;
}

export type ChatAsk = (AskOfName & { kind: "mention" }) | (AskOfName & { kind: "from" }) | { conversation: string; kind: "share"; text: string };

type Kind = ChatAsk["kind"];

let pending: ChatAsk | null = null;
const listeners = new Set<(ask: ChatAsk) => void>();

export function askChat(ask: ChatAsk): void {
  pending = ask;
  for (const listener of listeners) listener(ask);
}

/** What waits for this chat of this kind, once. */
export function takeAsk<K extends Kind>(conversation: string, kind: K): Extract<ChatAsk, { kind: K }> | null {
  if (pending?.conversation !== conversation || pending.kind !== kind) return null;
  const ask = pending as Extract<ChatAsk, { kind: K }>;
  pending = null;
  return ask;
}

export function onAsk(listener: (ask: ChatAsk) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
