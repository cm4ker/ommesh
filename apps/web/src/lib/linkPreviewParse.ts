/**
 * What the client needs of a link preview besides the server's answer
 * (`linkFetch.ts`): which links get one at all, and the card's data.
 */

/** What a card shows for a link; its picture, if any, is kept apart as a blob. */
export interface Preview {
  /** A page, a picture on its own, or any other file. */
  kind: "page" | "picture" | "file";
  /** The host that answered, as the server shows it: its own letters, or xn-- when they could pass for another's. */
  host: string;
  title: string;
  description: string;
  /** The picture goes across the card rather than beside the text. */
  large: boolean;
  video: boolean;
  /** A video's length in seconds, when the page says. */
  duration: number | null;
  /** A file's name, size in bytes, and the short mark on its badge. */
  file: { name: string; size: number | null; mark: string } | null;
}

/** The local names the server refuses too. */
const LOCAL_NAMES = ["localhost", "local", "lan", "home", "internal", "intranet", "corp", "private", "localdomain", "home.arpa", "test"];

/**
 * Whether a link may have a preview at all: the web's schemes and ports, no
 * credentials, and a host on the open internet. The server checks again,
 * after resolving the name; this only keeps the mark off links it would
 * refuse, and keeps an address in a home network from leaving the device.
 */
export function linkAllowed(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) return v6Public(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return v4Public(host.split(".").map(Number));
  if (!host.includes(".")) return false;
  const name = host.replace(/\.$/, "");
  return !LOCAL_NAMES.some((local) => name === local || name.endsWith(`.${local}`));
}

function v4Public([a = 0, b = 0, c = 0]: number[]): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** A literal IPv6 host: refused when it is any of the local or special kinds, which a link has no business naming. */
function v6Public(host: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return v4Public(mapped[1]!.split(".").map(Number));
  return !/^(::|::1|::ffff:|f[cd]|fe[89ab]|fec|fed|fee|fef|ff|64:ff9b:|2002:|2001:0?:|2001:db8:|100::)/.test(host) && host !== "::" && host !== "::1";
}

/** `12:47`, or `1:02:03` for an hour or more. */
export function durationLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
