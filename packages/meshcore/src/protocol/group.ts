/**
 * What a channel message looks like on the air, built the way the firmware
 * builds it (`BaseChatMesh::sendGroupMessage`, `Mesh::createGroupDatagram`,
 * `Utils::encryptThenMAC`). The radio encrypts on its own, so the client
 * never needs this to send; it needs it to recognise its own message when
 * a repeater sends it back, which is how it learns who heard it.
 *
 * Everything here is WebCrypto, which browsers, WebView2, WKWebView and Node
 * all have. AES-ECB is not in WebCrypto; each block is encrypted as the
 * first block of a zero-IV CBC, which is the same thing.
 */
import { ByteWriter, concat, utf8 } from "./bytes.js";
import { MAX_FRAME_SIZE, MAX_TEXT_LEN, TxtType } from "./codes.js";

const CIPHER_KEY_SIZE = 16;
const CIPHER_MAC_SIZE = 2;
const HMAC_KEY_SIZE = 32;

/**
 * The longest `name: text` this client puts in a channel message: with the
 * time and flags before it, ten cipher blocks, where MAX_TEXT_LEN would make
 * eleven. A repeater's copy of an eleven-block message can never be heard
 * (see `relaysAudible`), and the message would look unrelayed however far it
 * went (#84).
 */
export const CHANNEL_TEXT_LEN = 155;

/**
 * A heard packet's frame around its cipher text: the push code, SNR and RSSI;
 * the header, region codes, path length and one hop of the longest hash; the
 * channel hash and the MAC.
 */
const ECHO_FRAME_HEAD = 3 + 1 + 4 + 1 + 3 + 1 + CIPHER_MAC_SIZE;

/**
 * Whether a repeater's copy of our channel message could reach the app at
 * all. The radio hands a heard packet up only whole in one frame
 * (`MyMesh::logRxRaw`), and drops a longer one without a word. A copy is
 * reckoned at its longest, so one that fits is seen whatever the mesh's
 * region and hash settings.
 */
export function relaysAudible(senderName: string, text: string): boolean {
  const plain = 4 + 1 + Math.min(MAX_TEXT_LEN, utf8(`${senderName}: `).length + utf8(text).length);
  return ECHO_FRAME_HEAD + Math.ceil(plain / 16) * 16 <= MAX_FRAME_SIZE;
}

/** WebCrypto wants a buffer it can own; a view into the frame is copied out. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available here");
  return s;
}

/** A 128-bit secret is kept in a 32-byte field with zeros after it; a 256-bit one fills it. */
function keyLength(secret: Uint8Array): number {
  return secret.length >= 32 && secret.subarray(16, 32).some((b) => b !== 0) ? 32 : 16;
}

/** The first byte of SHA-256 of the secret: how a packet names its channel. */
export async function channelHash(secret: Uint8Array): Promise<number> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", own(secret.subarray(0, keyLength(secret)))));
  return digest[0]!;
}

/** AES-128-ECB with the last partial block zero-padded, as `Utils::encrypt`. */
async function encryptBlocks(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey("raw", own(key), "AES-CBC", false, ["encrypt"]);
  const iv = new Uint8Array(16);
  const blocks = Math.ceil(data.length / 16);
  const out = new Uint8Array(blocks * 16);
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(16);
    block.set(data.subarray(b * 16, (b + 1) * 16));
    const enc = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv }, cryptoKey, block));
    out.set(enc.subarray(0, 16), b * 16);
  }
  return out;
}

/** HMAC-SHA256 over the cipher text, keyed with the whole 32-byte secret field. */
async function mac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey("raw", own(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", cryptoKey, own(data))).subarray(0, CIPHER_MAC_SIZE);
}

/** The payload of a group packet: channel hash, MAC, cipher text of `plain`. */
export async function groupPayload(secret: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const field = new Uint8Array(HMAC_KEY_SIZE);
  field.set(secret.subarray(0, Math.min(secret.length, HMAC_KEY_SIZE)));
  const cipher = await encryptBlocks(field.subarray(0, CIPHER_KEY_SIZE), plain);
  return concat(new Uint8Array([await channelHash(secret)]), await mac(field, cipher), cipher);
}

/**
 * The payload of a channel text message: the plain text is the timestamp,
 * TXT_TYPE_PLAIN and `name: text`, the text cut so the whole fits MAX_TEXT_LEN,
 * as `sendGroupMessage` cuts it.
 */
export async function groupTextPayload(secret: Uint8Array, timestamp: number, senderName: string, text: string): Promise<Uint8Array> {
  const prefix = utf8(`${senderName}: `);
  let body = utf8(text);
  if (prefix.length + body.length > MAX_TEXT_LEN) body = body.subarray(0, Math.max(0, MAX_TEXT_LEN - prefix.length));
  const plain = new ByteWriter().u32(timestamp).u8(TxtType.Plain).bytes(prefix).bytes(body).toBytes();
  return groupPayload(secret, plain);
}

/**
 * The payload of a channel message somebody else sent, from what the radio
 * handed up: its whole text, `name: text` as it was encrypted, and the text
 * type the firmware shifted out of the flags byte. Encryption here has no
 * nonce, so the same message always makes the same payload: this is how the
 * copies of it the radio overheard are recognised.
 */
export async function heardGroupTextPayload(secret: Uint8Array, timestamp: number, txtType: number, text: string): Promise<Uint8Array> {
  const plain = new ByteWriter().u32(timestamp).u8(txtType << 2).bytes(utf8(text)).toBytes();
  return groupPayload(secret, plain);
}
