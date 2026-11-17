/**
 * Attachments: a photo or a file goes into the reader's own S3 bucket, and the
 * message carries a link (#118). Nothing but the link rides the radio, so the
 * work here is the bucket: its settings, the signature on each upload, the
 * photo squeezed before it goes and the link built short enough for a message.
 *
 * The secret never leaves the device and never enters a backup: it signs every
 * request here, and only the signature travels.
 */

import { useSyncExternalStore } from "react";
import { locale, t } from "../i18n/index.js";
import { readSetting, writeSetting } from "./storage.js";

export interface AttachmentsSettings {
  /**
   * The endpoint and the bucket in one address, as the storage's own page shows
   * it: `https://s3.example.ru/photos`. Everything else — where the upload goes,
   * where the link is read — follows from it.
   */
  server: string;
  accessKey: string;
  secretKey: string;
  /**
   * The region the storage insisted on, once it has said so. Unset is
   * `us-east-1`, which every storage but Amazon's own regional buckets accepts;
   * Amazon names the region it wants, and one retry puts it here.
   */
  region?: string;
}

/** Where a bucket lives, read out of one address. */
export interface BucketAddress {
  /** `https://preview.ommesh.ru` */
  endpoint: string;
  /** `files` */
  bucket: string;
}

export const ATTACH_DEFAULTS: AttachmentsSettings = {
  server: "",
  accessKey: "",
  secretKey: "",
};

/** The reader's own bucket, on this device only. */
const KEY = "meshnet.attachments";

/** S3's own rule for a bucket name: three letters at least, no capitals. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * The endpoint and the bucket out of the one address the reader was given, or
 * null when it does not name a bucket. The bucket is the first segment of the
 * path — the bucket in the path — which is what every self-hosted storage and
 * both big clouds accept.
 */
export function parseServer(server: string): BucketAddress | null {
  let url: URL;
  try {
    url = new URL(server.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const bucket = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!BUCKET_NAME.test(bucket)) return null;
  return { endpoint: `${url.protocol}//${url.host}`, bucket };
}

/** Settings as they are kept between versions: the old fields became one address. */
function stored(): AttachmentsSettings {
  const raw = readSetting<Partial<AttachmentsSettings> & { endpoint?: string; bucket?: string }>(KEY, {});
  if (typeof raw.server === "string") return { ...ATTACH_DEFAULTS, ...raw, server: raw.server };
  // Before the server came as one address, it was the endpoint, the bucket, the
  // public address and the path-style switch, each of them the reader's to fill.
  // The region goes too: it was free text there, and the one every storage but
  // Amazon accepts is taken now, with Amazon's own named back on the first upload.
  const endpoint = (raw.endpoint ?? "").trim().replace(/\/+$/, "");
  const bucket = (raw.bucket ?? "").trim();
  return {
    ...ATTACH_DEFAULTS,
    server: endpoint && bucket ? `${endpoint}/${bucket}` : "",
    accessKey: raw.accessKey ?? "",
    secretKey: raw.secretKey ?? "",
  };
}

let settings = stored();
const listeners = new Set<() => void>();

export function getAttachments(): AttachmentsSettings {
  return settings;
}

export function setAttachments(patch: Partial<AttachmentsSettings>): void {
  settings = { ...settings, ...patch };
  writeSetting(KEY, settings);
  for (const listener of listeners) listener();
}

export function useAttachments(): AttachmentsSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => settings,
  );
}

/** Whether an upload can go at all: an address that names a bucket and both keys. */
export function attachmentsReady(s = settings): boolean {
  return parseServer(s.server) !== null && s.accessKey.trim() !== "" && s.secretKey.trim() !== "";
}

/** The host the link is read from: the endpoint's own bucket path. */
export function publicBase(s = settings): string {
  const address = parseServer(s.server);
  return address ? `${address.endpoint}/${address.bucket}` : s.server.trim().replace(/\/+$/, "");
}

/** What the reader actually gets in a message: a short key, so the link fits 158 bytes. */
export function linkFor(key: string, s = settings): string {
  return `${publicBase(s)}/${key}`;
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A phone photo before squeezing; the squeeze brings it down on its own. */
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const MAX_SIDE = 1600;
export const TARGET_BYTES = 400 * 1024;

export class AttachError extends Error {
  constructor(
    readonly code: "not-configured" | "too-big" | "network" | "refused" | "read" | "photo",
    readonly status = 0,
    /** What the storage said, when it said anything: Amazon names the region it wants here. */
    readonly body = "",
  ) {
    super(code);
    this.name = "AttachError";
  }
}

/** Eight hex characters: short in the message, and unlikely to meet another upload. */
function shortId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EXTENSION = /\.([a-z0-9]{1,8})$/i;

/** A photo keeps its kind of file; a file keeps its extension, which the card shows as a badge. */
export function keyFor(kind: "photo" | "file", name: string, type = ""): string {
  const fromName = EXTENSION.exec(name)?.[1]?.toLowerCase() ?? "";
  const fromType = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase() ?? "";
  const extension = kind === "photo" ? (fromName === "png" ? "png" : "jpg") : fromName || fromType || "bin";
  return `${kind === "photo" ? "p" : "f"}/${shortId()}.${extension}`;
}

/* ---------- SigV4: a PUT the bucket accepts without seeing the secret ---------- */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/** Long enough for a slow phone upload, short enough not to leak a link that works forever. */
const EXPIRES_S = 900;

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(text));
}

async function signingKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
  const byDate = await hmac(encoder.encode(`AWS4${secret}`), date);
  const byRegion = await hmac(byDate, region);
  const byService = await hmac(byRegion, SERVICE);
  return hmac(byService, "aws4_request");
}

/** A bucket reached by the path of its endpoint, which is how every storage but a name-per-bucket cloud answers. */
function targetFor(s: AttachmentsSettings, key: string): { host: string; path: string; secure: boolean } {
  const address = parseServer(s.server);
  if (!address) throw new AttachError("not-configured");
  const endpoint = new URL(address.endpoint);
  return {
    host: endpoint.host,
    path: `/${address.bucket}/${key}`,
    secure: endpoint.protocol !== "http:",
  };
}

/** What the storage signed for when the reader never said: the region every one of them but Amazon accepts. */
const DEFAULT_REGION = "us-east-1";

/** The region a refusal names, if it names one: `<Region>eu-central-1</Region>` or the header Amazon sends. */
export function regionFrom(body: string, header: string | null): string | null {
  const named = /<Region>\s*([a-z0-9-]+)\s*<\/Region>/i.exec(body)?.[1] ?? header?.trim() ?? "";
  return /^[a-z0-9-]{2,32}$/i.test(named) ? named : null;
}

const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A presigned PUT for one key: the bucket checks the signature, and never sees the secret. */
export async function presignPut(s: AttachmentsSettings, key: string, at = new Date()): Promise<string> {
  if (!attachmentsReady(s)) throw new AttachError("not-configured");
  const { host, path, secure } = targetFor(s, key);
  const region = (s.region ?? DEFAULT_REGION).trim();
  const amzDate = stamp(at);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${SERVICE}/aws4_request`;
  const query: [string, string][] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${s.accessKey.trim()}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(EXPIRES_S)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  // The payload is not hashed: it is a photo or a file, and hashing it twice on a phone costs more than it gives.
  const canonicalRequest = ["PUT", path, canonicalQuery, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(s.secretKey.trim(), date, region), stringToSign));
  return `${secure ? "https" : "http"}://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* ---------- the upload, and what a photo becomes before it ---------- */

/** Puts the bytes at a presigned address, saying how far it has gone. */
export function putBytes(url: string, body: Blob, name: string, onProgress: (share: number) => void, signal: AbortSignal, contentType = body.type): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType || "application/octet-stream");
    // The reader's own name for the file, in UTF-8, so a card can say «Договор аренды.pdf».
    request.setRequestHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new AttachError("refused", request.status, request.responseText ?? ""));
    // A blocked CORS preflight and no network both end here, with no status to tell them apart.
    request.onerror = () => reject(new AttachError("network"));
    request.onabort = () => reject(new AttachError("network"));
    signal.addEventListener("abort", () => request.abort());
    request.send(body);
  });
}

function loadImage(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement; width: number; height: number; close(): void }> {
  // The camera's own orientation is applied here; the canvas then has an upright picture.
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" }).then((bitmap) => ({
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () =>
      resolve({
        bitmap: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new AttachError("photo"));
    };
    image.src = url;
  });
}

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new AttachError("photo"))), type, quality);
  });

/**
 * A photo as it goes: upright, no more than 1600 px on the long side, no more
 * than about 400 KB, and without EXIF — the canvas is a new picture, so the
 * coordinates the camera wrote stay on the phone.
 */
export async function compressPhoto(file: File): Promise<{ blob: Blob; name: string; width: number; height: number }> {
  const image = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    let width = Math.max(1, Math.round(image.width * scale));
    let height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new AttachError("photo");
    // A see-through picture keeps its transparency; everything else becomes a JPEG, which is smaller.
    const keepTransparency = file.type === "image/png";
    let best: Blob | null = null;
    for (let round = 0; round < 3; round++) {
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      if (!keepTransparency) {
        // What was transparent becomes white rather than black.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image.bitmap as CanvasImageSource, 0, 0, width, height);
      for (const quality of [0.82, 0.7, 0.6, 0.5, 0.4]) {
        const blob = await canvasToBlob(canvas, keepTransparency ? "image/png" : "image/jpeg", quality);
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= TARGET_BYTES) return { blob, name: file.name, width, height };
      }
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
    return { blob: best as Blob, name: file.name, width, height };
  } finally {
    image.close();
  }
}

/** What a file weighs, said the way the app says sizes. */
export function sizeText(bytes: number): string {
  // The reader's decimal mark and the app's own units, as a file card says a size.
  const number = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 1 });
  return bytes >= 1024 * 1024 ? t("chats.preview.mb", { size: number(bytes / 1024 / 1024) }) : t("chats.preview.kb", { size: number(Math.max(1, bytes / 1024)) });
}

/** Asks the disk, or the camera, for one file; null when the picker was put away. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    // A picker put away without a file fires nothing on some phones; the window coming back is the cue.
    window.addEventListener(
      "focus",
      () => setTimeout(() => done(input.files?.[0] ?? null), 1000),
      { once: true },
    );
    document.body.append(input);
    input.click();
  });
}

/**
 * Signs and puts, taking the region the storage names if it refused the one
 * signed for: Amazon's regional buckets want their own, and the reader should
 * not have to know which.
 */
export async function uploadAt(s: AttachmentsSettings, key: string, blob: Blob, name: string, onProgress: (share: number) => void, signal: AbortSignal, contentType?: string): Promise<AttachmentsSettings> {
  let current = s;
  for (let attempt = 0; ; attempt++) {
    try {
      const url = await presignPut(current, key);
      await putBytes(url, blob, name, onProgress, signal, contentType);
      return current;
    } catch (error) {
      const named = attempt === 0 && error instanceof AttachError && error.status >= 400 && error.status < 500 ? regionFrom(error.body, null) : null;
      if (!named || named === (current.region ?? DEFAULT_REGION)) throw error;
      current = { ...current, region: named };
      setAttachments({ region: named });
    }
  }
}

/** Puts a small object in and reads it back: the whole way a photo takes, in a second. */
export async function testBucket(s: AttachmentsSettings): Promise<{ ms: number }> {
  if (!attachmentsReady(s)) throw new AttachError("not-configured");
  const started = performance.now();
  const key = `t/${shortId()}.txt`;
  const used = await uploadAt(s, key, new Blob(["ommesh"], { type: "text/plain" }), "ommesh-test.txt", () => undefined, new AbortController().signal, "text/plain");
  // What the reader sees is the public address, so it is the one checked.
  const answer = await fetch(linkFor(key, used), { method: "GET", cache: "no-store" }).catch(() => null);
  if (!answer || !answer.ok) throw new AttachError("read", answer?.status ?? 0);
  return { ms: Math.round(performance.now() - started) };
}



