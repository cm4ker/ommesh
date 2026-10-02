/**
 * Something asked of a chat from outside it, by the list of who writes in a
 * channel (#64): to name a person in the field ("mention"), or to step
 * through only their messages ("from"). A chat opening takes what waits for
 * it as it mounts; one already open, as on the desktop, hears it.
 */

export interface ChatAsk {
  conversation: string;
  kind: "mention" | "from";
  name: string;
}

let pending: ChatAsk | null = null;
const listeners = new Set<(ask: ChatAsk) => void>();

export function askChat(ask: ChatAsk): void {
  pending = ask;
  for (const listener of listeners) listener(ask);
}

/** What waits for this chat of this kind, once. */
export function takeAsk(conversation: string, kind: ChatAsk["kind"]): ChatAsk | null {
  if (pending?.conversation !== conversation || pending.kind !== kind) return null;
  const ask = pending;
  pending = null;
  return ask;
}

export function onAsk(listener: (ask: ChatAsk) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
