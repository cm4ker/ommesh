/**
 * Reading what a link's address answered into a preview, with no network and
 * no DOM: the native fetch (`linkFetch.ts`) hands over bytes, and this finds a
 * page's title, description and picture in them, tells a picture's size from
 * its first bytes, and names a file. Everything here is a stranger's text, so
 * it comes out as plain, short, cleaned strings and never as markup.
 */

/** What a card shows for a link. */
export interface Preview {
  /** A page, a picture on its own, or any other file. */
  kind: "page" | "picture" | "file";
  /** The host that answered, as shown: see `shownHost`. */
  host: string;
  title: string;
  description: string;
  /** The page's picture, an address still to fetch. */
  image: string | null;
  /** The page asks for its picture across the card rather than beside the text. */
  large: boolean;
  video: boolean;
  /** A video's length in seconds, when the page says. */
  duration: number | null;
  /** A file's name, size in bytes, and the short mark on its badge. */
  file: { name: string; size: number | null; mark: string } | null;
}

/** The parts of a page's head a preview uses. */
export interface Head {
  title: string;
  description: string;
  image: string | null;
  large: boolean;
  video: boolean;
  duration: number | null;
}

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 300;
/** Larger than this a picture is not decoded: two megabytes of PNG can unpack to gigabytes. */
export const PICTURE_SIDE_MAX = 4096;

/** The local names the native fetch refuses too; see `crates/link-fetch/src/vet.rs`. */
const LOCAL_NAMES = ["localhost", "local", "lan", "home", "internal", "intranet", "corp", "private", "localdomain", "home.arpa", "test"];

/**
 * Whether a link may have a preview at all: the web's schemes and ports, no
 * credentials, and a host on the open internet. The native fetch checks again,
 * after resolving the name; this only keeps the mark off links it would refuse.
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

/** Whether a preview may come by itself: only over an encrypted link, which nobody on the way can change. */
export function autoAllowed(href: string): boolean {
  return linkAllowed(href) && href.toLowerCase().startsWith("https:");
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

/** The type of a `Content-Type`, lower case, without its parameters. */
export function mimeOf(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

export function isPage(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

export function isPicture(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif";
}

/**
 * A page's bytes as text, in the encoding its header names, else the one its
 * own `<meta>` names, else UTF-8: many Russian sites still send windows-1251.
 */
export function decodePage(bytes: Uint8Array, contentType: string): string {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 2048)))?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bdquo: "„",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  numero: "№",
};

/** Character references, numeric and the common named ones, as the characters they stand for. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * A stranger's text made safe to show: references decoded, control characters
 * and the marks that reverse a line's direction taken out (they can make one
 * address read as another), spaces collapsed, and cut to `max` characters.
 */
export function cleanText(text: string, max: number): string {
  const plain = decodeEntities(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...plain];
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** A tag's attributes, names in lower case. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([^\s=/>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** An ISO 8601 duration as a page states a video's length (`PT12M47S`), in seconds. */
export function isoSeconds(text: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(text.trim());
  if (!m || text.trim().length < 3) return null;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Math.round(Number(s));
}

/** `12:47`, or `1:02:03` for an hour or more. */
export function durationLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * The title, description and picture a page gives for previews: Open Graph
 * first, then Twitter's cards, then its own `<title>` and description.
 * Scripts, styles and comments are dropped first, so a tag written inside
 * them is not taken for one. `base` resolves a relative picture address.
 */
export function readHead(html: string, base: string): Head {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  const meta = new Map<string, string>();
  for (const m of text.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(m[1]!);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop") ?? "").toLowerCase();
    const content = attrs.get("content");
    // The first of each counts, as a page lists its main picture first.
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v !== undefined && v.trim() !== "");
  const ownTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text)?.[1];
  const imageRaw = first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  let image: string | null = null;
  if (imageRaw) {
    try {
      const url = new URL(decodeEntities(imageRaw.trim()), base);
      if (url.protocol === "https:" || url.protocol === "http:") image = url.href;
    } catch {
      // A picture address that does not parse is no picture.
    }
  }
  const type = (first("og:type") ?? "").toLowerCase();
  const card = (first("twitter:card") ?? "").toLowerCase();
  const video = type.startsWith("video");
  const seconds = first("duration", "video:duration", "og:video:duration");
  const duration = seconds === undefined ? null : /^\d+$/.test(seconds.trim()) ? Number(seconds) : isoSeconds(seconds);
  return {
    title: cleanText(first("og:title", "twitter:title") ?? ownTitle ?? "", TITLE_MAX),
    description: cleanText(first("og:description", "twitter:description", "description") ?? "", DESCRIPTION_MAX),
    image,
    large: video || card === "summary_large_image" || card === "player",
    video,
    duration: duration && duration > 0 ? duration : null,
  };
}

/** One label of a domain from its `xn--` form, after RFC 3492; null when it does not decode. */
export function punycodeLabel(label: string): string | null {
  if (!label.startsWith("xn--")) return label;
  const input = label.slice(4);
  const base = 36;
  const out: number[] = [];
  const cut = input.lastIndexOf("-");
  for (const ch of cut > 0 ? input.slice(0, cut) : "") out.push(ch.charCodeAt(0));
  let n = 128;
  let bias = 72;
  let i = 0;
  let at = cut > 0 ? cut + 1 : 0;
  while (at < input.length) {
    const old = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (at >= input.length) return null;
      const c = input.charCodeAt(at++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const length = out.length + 1;
    let delta = old === 0 ? Math.floor((i - old) / 700) : Math.floor((i - old) / 2);
    delta += Math.floor(delta / length);
    let k = 0;
    while (delta > 455) {
      delta = Math.floor(delta / 35);
      k += base;
    }
    bias = k + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff) return null;
    out.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...out);
}

/** Cyrillic letters that read as Latin ones. */
const LATIN_LOOKALIKES = /^[асԁеһіјӏорԛѕԝху]+$/u;
/** Top-level domains written in Cyrillic, under which a Cyrillic name is expected. */
const CYRILLIC_TOP = /\p{Script=Cyrillic}/u;

/**
 * A host as a card shows it: without `www.`, in its own letters when they
 * are of one alphabet (`пример.рф`), and left as `xn--…` when a label mixes
 * alphabets, which is how a fake `аpple.com` with a Cyrillic а gives itself
 * away, or when a Cyrillic label is made only of letters that read as Latin
 * under a Latin top-level domain (`аррӏе.com`).
 */
export function shownHost(href: string): string {
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  const labels = host.split(".");
  const decoded = labels.map(punycodeLabel);
  if (decoded.some((label) => label === null)) return host;
  const latinTop = !CYRILLIC_TOP.test(decoded[decoded.length - 1]!);
  const deceiving = decoded.some((label) => {
    const latin = /[a-z]/i.test(label!);
    const cyrillic = /\p{Script=Cyrillic}/u.test(label!);
    const greek = /\p{Script=Greek}/u.test(label!);
    return Number(latin) + Number(cyrillic) + Number(greek) > 1 || (latinTop && LATIN_LOOKALIKES.test(label!.replace(/[-\d]/g, "")));
  });
  return deceiving ? host : decoded.join(".");
}

/** A picture's kind and size from its first bytes, without decoding it; null when it is none of the four kinds. */
export function pictureSize(bytes: Uint8Array): { type: string; width: number; height: number } | null {
  const at = (i: number) => bytes[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const be32 = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return { type: "image/png", width: be32(16), height: be32(20) };
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") return { type: "image/gif", width: le16(6), height: le16(8) };
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { type: "image/webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = (i: number) => at(21 + i);
      return { type: "image/webp", width: 1 + (((b(1) & 0x3f) << 8) | b(0)), height: 1 + (((b(3) & 0xf) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { type: "image/webp", width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) };
    return null;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // The markers after the start, each with its length, up to the frame that states the size.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "image/jpeg", width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

/** Whether a picture of this size may be decoded in a message. */
export function pictureFits(size: { width: number; height: number }): boolean {
  return size.width > 0 && size.height > 0 && size.width <= PICTURE_SIDE_MAX && size.height <= PICTURE_SIDE_MAX;
}

/**
 * A file's name, from the name its server gives it (`Content-Disposition`)
 * or the last part of its address, and the mark on its badge, from its
 * extension or else its type.
 */
export function fileOf(href: string, disposition: string | null, contentType: string, size: number | null): NonNullable<Preview["file"]> {
  let name = "";
  const star = disposition ? /filename\*\s*=\s*[\w-]+'[^']*'([^;]+)/i.exec(disposition)?.[1] : undefined;
  const plain = disposition ? /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition) : null;
  try {
    name = star ? decodeURIComponent(star.trim()) : (plain?.[1] ?? plain?.[2] ?? "").trim();
  } catch {
    name = "";
  }
  if (!name) {
    try {
      const path = new URL(href).pathname.split("/").filter(Boolean);
      name = decodeURIComponent(path[path.length - 1] ?? "");
    } catch {
      name = "";
    }
  }
  name = cleanText(name.replace(/^.*[\\/]/, ""), 120);
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  const subtype = mimeOf(contentType).split("/")[1]?.replace(/^x-/, "").replace(/[^a-z0-9].*$/, "");
  const mark = (extension ?? subtype ?? "").slice(0, 4).toUpperCase() || "FILE";
  return { name: name || new URL(href).hostname, size, mark };
}
