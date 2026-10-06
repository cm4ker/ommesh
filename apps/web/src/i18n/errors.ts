import { MeshCoreError, NoReplyError, TimeoutError, TransportClosedError } from "@meshnet/meshcore";
import { t, type Key } from "./index.js";

/**
 * The protocol package speaks English to programmers; what of it reaches the
 * reader is said here in the reader's language. Anything else keeps its own words.
 */
const KNOWN: Record<string, Key> = {
  "The radio's memory is full. Remove a few contacts first.": "common.error.memoryFull",
  "not connected": "common.error.notConnected",
  "unknown contact": "common.error.unknownContact",
  "this sender is not in the contacts yet": "common.error.senderNotContact",
  "this channel is not on the radio": "common.error.channelGone",
};

/** An error as the reader should read it. */
export function errorText(error: unknown): string {
  if (error instanceof NoReplyError) return t("common.error.noReply", { seconds: /(\d+) s$/.exec(error.message)?.[1] ?? "?" });
  if (error instanceof TimeoutError) return t("common.error.timedOut");
  if (error instanceof TransportClosedError) return t("common.error.linkClosed");
  if (error instanceof MeshCoreError) return t("common.error.refused", { reason: error.message });
  const message = error instanceof Error ? error.message : String(error);
  const known = KNOWN[message];
  if (known) return t(known);
  const long = /^message is (\d+) bytes; the radio carries at most (\d+)$/.exec(message);
  if (long) return t("common.error.tooLong", { bytes: long[1]!, max: long[2]! });
  return message;
}
