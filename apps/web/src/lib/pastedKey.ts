import { AdvType, fromHex, parseAdvert, parseRawPacket, PayloadType } from "@meshnet/meshcore";

/**
 * What someone sent to be added, as it was pasted: a node's key, a channel's
 * key, a radio's private key by mistake, or nothing that can be read.
 */
export type Pasted =
  | { kind: "node"; key: string; type: number; name: string; lat: number | null; lon: number | null }
  | { kind: "channel"; secret: string; name: string }
  | { kind: "private" }
  | { kind: "unknown" };

const node = (key: string, type = AdvType.Chat as number, name = "", lat: number | null = null, lon: number | null = null): Pasted => ({ kind: "node", key, type, name, lat, lon });

/** A kind a link names, or a person when it names none the radio knows. */
function kindOf(text: string | null): number {
  const n = Number(text);
  return Number.isInteger(n) && n >= AdvType.Chat && n <= AdvType.Sensor ? n : AdvType.Chat;
}

/**
 * Reads what was pasted, null while the field is empty. The lengths tell the
 * kinds apart: a node's public key is 32 bytes, a channel's key 16, a radio's
 * private key 64. A `meshcore://` link carries either a whole advert, as the
 * radio exports a contact, or the fields of a contact or a channel. Spaces,
 * colons and dashes a messenger or another app put into a key are dropped.
 */
export function readPasted(text: string): Pasted | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const link = /^meshcore:\/\/(.*)$/is.exec(trimmed);
  if (link) {
    const rest = link[1]!.replace(/\s+/g, "");
    if (/^([0-9a-f]{2})+$/i.test(rest)) {
      const packet = parseRawPacket(fromHex(rest));
      const advert = packet?.payloadType === PayloadType.Advert ? parseAdvert(packet.payload) : null;
      return advert ? node(advert.key, advert.type || AdvType.Chat, advert.name, advert.lat, advert.lon) : { kind: "unknown" };
    }
    let params: URLSearchParams;
    try {
      params = new URL(trimmed.replace(/\s+/g, "")).searchParams;
    } catch {
      return { kind: "unknown" };
    }
    const key = (params.get("public_key") ?? params.get("pubkey") ?? params.get("key") ?? "").toLowerCase();
    if (/^[0-9a-f]{64}$/.test(key)) return node(key, kindOf(params.get("type")), params.get("name") ?? "");
    const secret = (params.get("secret") ?? key).toLowerCase();
    if (/^[0-9a-f]{32}$/.test(secret)) return { kind: "channel", secret, name: params.get("name") ?? "" };
    return { kind: "unknown" };
  }
  const hex = trimmed.replace(/[\s:-]+/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return { kind: "unknown" };
  if (hex.length === 64) return node(hex);
  if (hex.length === 32) return { kind: "channel", secret: hex, name: "" };
  if (hex.length === 128) return { kind: "private" };
  return { kind: "unknown" };
}
