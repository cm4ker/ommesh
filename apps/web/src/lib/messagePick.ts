/**
 * Messages picked in a chat, as Telegram picks them: one by one, a stretch by
 * dragging over them, and what goes to the clipboard for those picked. The
 * gestures live in components/ChatPick.tsx; these are the rules they follow.
 */

/** The ids from `from` to `to` in `order`, both included, whichever comes first. */
export function idsBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** `ids` in the order the chat shows them, each once. */
function inOrder(order: readonly string[], ids: Iterable<string>): string[] {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
}

/** One message picked, or let go if it was. */
export function toggled(order: readonly string[], picked: readonly string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((x) => x !== id) : inOrder(order, [...picked, id]);
}

/** Shift and a click: everything from the message picked last up to this one is added. */
export function extended(order: readonly string[], picked: readonly string[], last: string, id: string): string[] {
  return inOrder(order, [...picked, ...idsBetween(order, last, id)]);
}

/**
 * A drag from `anchor` to `to` over what was picked before it began: the
 * messages it crosses are added, or, when it began on one already picked,
 * let go, so a second drag back over a stretch undoes it.
 */
export function dragged(order: readonly string[], before: readonly string[], anchor: string, to: string): string[] {
  const crossed = idsBetween(order, anchor, to);
  if (!before.includes(anchor)) return inOrder(order, [...before, ...crossed]);
  return before.filter((id) => !crossed.includes(id));
}

/**
 * What goes to the clipboard. One message alone is its words, as "Copy the
 * text" gives them. Several are each headed by who wrote it and when, so they
 * still read as a conversation wherever they are pasted.
 */
export function copiedText<T extends { text: string }>(messages: readonly T[], head: (message: T) => string): string {
  if (messages.length === 1) return messages[0]!.text;
  return messages.map((m) => `${head(m)}\n${m.text}`).join("\n\n");
}
