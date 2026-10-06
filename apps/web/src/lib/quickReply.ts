/**
 * A reply typed into a notice rather than in the chat (the desktop's own
 * cards): sent as the composer would send it, with lookalike letters packed
 * and, when it is too long for one message, in parts.
 */

import { parseConversation } from "@meshnet/meshcore";
import { ceilingOf, costOf, headerBytes, pathBytes, splitParts } from "./composer.js";
import { getLookalikePrefs, packLookalikes } from "./lookalikes.js";
import { session } from "./session.js";

export async function quickReply(conversation: string, text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const state = session.getState();
  const target = parseConversation(conversation);
  const contact = target.kind === "contact" ? state.contacts[target.key] : undefined;
  const pack = (t: string) => packLookalikes(t, getLookalikePrefs());
  const prefix = target.kind === "channel" ? `${state.self?.name ?? ""}: ` : "";
  const header = target.kind === "channel" ? headerBytes("channel") : headerBytes("direct", contact ? pathBytes(contact.outPathLen) : 0);
  const cost = costOf(body, { pack, prefix, ceiling: ceilingOf(target.kind === "channel" ? "channel" : "direct"), header, radio: null });
  if (cost.over <= 0) {
    await session.sendText(conversation, pack(body), { original: body });
    return;
  }
  for (const part of splitParts(pack(body), cost.budget)) await session.sendText(conversation, part);
}
