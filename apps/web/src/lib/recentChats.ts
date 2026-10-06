/**
 * The chats in the order they were last on screen, the latest first, for the
 * desktop's Ctrl+Tab switcher (#80), as Telegram's desktop app keeps them. Held
 * for this run of the app only: after a start, the chat list's order fills in.
 */

const KEEP = 20;
const recent: string[] = [];

/** A chat came on screen. */
export function noteShown(conversation: string): void {
  const at = recent.indexOf(conversation);
  if (at === 0) return;
  if (at > 0) recent.splice(at, 1);
  recent.unshift(conversation);
  if (recent.length > KEEP) recent.length = KEEP;
}

/**
 * Up to `count` chats to switch between: the one on screen first, then the
 * ones seen before it, latest first, then the rest as the list orders them.
 * Only chats still in the list, so one deleted or of another radio drops out.
 */
export function switchable(current: string | null, listed: readonly string[], count: number, seen: readonly string[] = recent): string[] {
  const known = new Set(listed);
  const out: string[] = [];
  for (const id of [current, ...seen, ...listed]) {
    if (out.length === count) break;
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
