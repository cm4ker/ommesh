/**
 * The radio's own key. MeshCore keeps it as orlp/ed25519 does: 64 bytes, the
 * clamped scalar and then the half used for signing. The public key is the
 * scalar times the curve's base point (`ed25519_derive_pub` in the firmware),
 * worked out here so a key read from a file or pasted can be told apart
 * before the radio is asked to take it.
 */

const P = 2n ** 255n - 19n;
/** The order of the base point. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D = mod(-121665n * invert(121666n));
const BASE: Point = [
  15112221349535400772501151409588531511454012693041857206046113283949847762202n,
  46316835694926478169428394003475163141307993866256225615783033603165251855960n,
  1n,
  mod(15112221349535400772501151409588531511454012693041857206046113283949847762202n * 46316835694926478169428394003475163141307993866256225615783033603165251855960n),
];

/** A point in extended coordinates: X, Y, Z, T with x = X/Z, y = Y/Z and xy = T/Z. */
type Point = [bigint, bigint, bigint, bigint];

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function power(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

function invert(a: bigint): bigint {
  return power(a, P - 2n);
}

/** Addition on the twisted Edwards curve with a = −1 ("add-2008-hwcd-3"); complete, so it doubles too. */
function add([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(t1 * 2n * D * t2);
  const d = mod(z1 * 2n * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function multiply(point: Point, scalar: bigint): Point {
  let result: Point = [0n, 1n, 1n, 0n];
  let addend = point;
  for (let k = scalar; k > 0n; k >>= 1n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
  }
  return result;
}

function encode([x, y, z]: Point): Uint8Array {
  const zi = invert(z);
  const ax = mod(x * zi);
  let ay = mod(y * zi);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(ay & 0xffn);
    ay >>= 8n;
  }
  if (ax & 1n) out[31] = out[31]! | 0x80;
  return out;
}

/** The public key of a 64-byte MeshCore private key. */
export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 64) throw new Error(`a private key is 64 bytes, got ${privateKey.length}`);
  let scalar = 0n;
  for (let i = 31; i >= 0; i--) scalar = (scalar << 8n) | BigInt(privateKey[i]!);
  return encode(multiply(BASE, scalar % L));
}

/** Little-endian bytes as a number. */
function readLe(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/**
 * The signature the radio makes of `message` with this private key, as
 * orlp/ed25519's `ed25519_sign` makes it (`CMD_SIGN_FINISH`): 64 bytes, the
 * nonce drawn from the key's second half and the message, so one message
 * always gets one signature. Only the demo radio signs here; a real one keeps
 * its key to itself.
 */
export async function signWith(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  if (privateKey.length !== 64) throw new Error(`a private key is 64 bytes, got ${privateKey.length}`);
  const hash = async (...parts: Uint8Array[]) => {
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return readLe(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-512", all))) % L;
  };
  const r = await hash(privateKey.subarray(32, 64), message);
  const point = encode(multiply(BASE, r));
  const k = await hash(point, publicKeyOf(privateKey), message);
  let s = (r + k * readLe(privateKey.subarray(0, 32))) % L;
  const out = new Uint8Array(64);
  out.set(point);
  for (let i = 32; i < 64; i++) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

/**
 * Whether the radio would take this private key (`LocalIdentity::validatePrivateKey`):
 * `shape` for 64 bytes that were never an ed25519 key (its scalar not clamped, so the
 * firmware's key exchange disagrees with its public key), `prefix` for one whose public
 * key starts 00 or FF, which the mesh keeps for itself.
 */
export function privateKeyFault(privateKey: Uint8Array): "shape" | "prefix" | null {
  if (privateKey.length !== 64) return "shape";
  const first = privateKey[0]!;
  const last = privateKey[31]!;
  if ((first & 7) !== 0 || (last & 0x80) !== 0 || (last & 0x40) === 0) return "shape";
  const lead = publicKeyOf(privateKey)[0];
  return lead === 0x00 || lead === 0xff ? "prefix" : null;
}
