/**
 * Regions, the firmware's "flood scope": a name a repeater is told to carry
 * floods for (`region allowf`). The radio marks every flood with a two-byte
 * code worked out from the region's key and the packet, and a repeater sends
 * on only a flood whose code matches a region it carries, or, unless its
 * owner turned that off, one with no code at all (`region denyf *`).
 *
 * A region named in the open has a key anyone can work out from its name
 * (`TransportKeyStore::getAutoKeyFor`); the "$" regions meant to have a
 * secret key cannot be kept by the firmware yet, and are not offered here.
 */
import { ByteWriter, utf8 } from "./bytes.js";

/** The longest name the firmware keeps: `char name[31]`, its end included. */
export const REGION_NAME_MAX = 30;

/** How a repeater lists floods sent without a region, and how this client names "no region" for a channel. */
export const UNSCOPED = "*";

/** The anonymous request a repeater answers with the regions it carries (`ANON_REQ_TYPE_REGIONS`). */
const ANON_REQ_REGIONS = 0x01;

/**
 * A name as it is typed, the way repeaters keep them: no "#" in front, lower
 * case, nothing but letters, digits and hyphens (docs/cli_commands.md); null
 * when what is left is not such a name.
 */
export function regionName(text: string): string | null {
  const name = text.trim().replace(/^#+/, "").toLowerCase();
  return /^[a-z0-9-]+$/.test(name) && name.length <= REGION_NAME_MAX ? name : null;
}

/**
 * A region's key: the first 16 bytes of SHA-256 of "#" and its name. A name
 * that already starts with "#" is taken as it is, as the firmware does.
 */
export async function regionKey(name: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here");
  const text = name.startsWith("#") ? name : `#${name}`;
  const digest = await subtle.digest("SHA-256", new Uint8Array(utf8(text)));
  return new Uint8Array(digest).slice(0, 16);
}

/**
 * The body of an anonymous request for a repeater's regions: its type, then
 * the way back, which is none, since the repeater answers only a request that
 * reached it direct and so hears this radio itself.
 */
export function regionsRequest(): Uint8Array {
  return new ByteWriter().u8(ANON_REQ_REGIONS).u8(0).toBytes();
}

/**
 * A repeater's answer, after its tag: its clock, then the regions it carries
 * floods for, by name and comma between, "*" first when it carries floods
 * with none (`RegionMap::exportNamesTo`). Anything that is not a name is left out.
 */
export function readRegionList(data: Uint8Array): string[] {
  if (data.length <= 4) return [];
  const text = new TextDecoder().decode(data.subarray(4)).replace(/\0.*$/s, "");
  const names: string[] = [];
  for (const part of text.split(",")) {
    const name = part.trim().replace(/^#/, "");
    if (name === UNSCOPED || (/^[^\s,]+$/.test(name) && name.length <= REGION_NAME_MAX)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}
