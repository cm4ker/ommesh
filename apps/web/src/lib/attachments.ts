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
import { readSetting, writeSetting } from "./storage.js";

export interface AttachmentsSettings {
  /** Off by default: nothing leaves the device until the reader sets a bucket. */
  enabled: boolean;
  /** The S3 endpoint, such as https://s3.example.ru. */
  endpoint: string;
  bucket: string;
  /** R2 says auto, Selectel ru-1, MinIO usually us-east-1. */
  region: string;
  accessKey: string;
  secretKey: string;
  /** Where the file is read from, such as https://i.example.ru. Empty: the endpoint and the bucket. */
  publicBase: string;
  /** Photos are squeezed to 1600 px and about 400 KB; files go as they are. */
  compressPhotos: boolean;
  /**
   * Whether the bucket sits in the path (`host/bucket/key`) rather than in the
   * host (`bucket.host/key`). Unset is auto: a port or an address in the
   * endpoint means a path, since a port cannot be a subdomain. Set by hand for
   * a bucket behind a proxy on the web's own port, which auto cannot tell apart.
   */
  pathStyle?: boolean;
}

export const ATTACH_DEFAULTS: AttachmentsSettings = {
  enabled: false,
  endpoint: "",
  bucket: "",
  region: "",
  accessKey: "",
  secretKey: "",
  publicBase: "",
  compressPhotos: true,
};

/** The reader's own bucket, on this device only. */
const KEY = "meshnet.attachments";

let settings = { ...ATTACH_DEFAULTS, ...readSetting<Partial<AttachmentsSettings>>(KEY, {}) };
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

/** Whether an upload can go at all: switched on and every field that matters filled. */
export function attachmentsReady(s = settings): boolean {
  return s.enabled && s.endpoint.trim() !== "" && s.bucket.trim() !== "" && s.region.trim() !== "" && s.accessKey.trim() !== "" && s.secretKey.trim() !== "";
}

/** The host the link is read from: the public base, or the endpoint's own bucket path. */
export function publicBase(s = settings): string {
  const base = s.publicBase.trim() || s.endpoint.trim().replace(/\/+$/, "");
  if (s.publicBase.trim() !== "") return base.replace(/\/+$/, "");
  return `${base}/${s.bucket.trim()}`;
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

/** A bucket reached by its own name under the endpoint, or by a path when the endpoint is an address and a port. */
function targetFor(s: AttachmentsSettings, key: string): { host: string; path: string; secure: boolean } {
  const endpoint = new URL(s.endpoint.trim());
  const bucket = s.bucket.trim();
  // A port or a bare address cannot be a subdomain, so those are a path; anything
  // else the reader may have said for himself, as a bucket behind a proxy cannot
  // be told apart from a bucket with its own name.
  const pathStyle = s.pathStyle ?? autoPathStyle(s);
  return {
    host: pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`,
    path: pathStyle ? `/${bucket}/${key}` : `/${key}`,
    secure: endpoint.protocol !== "http:",
  };
}

/** What the endpoint's own shape says about the bucket being in the path, with the reader silent. */
export function autoPathStyle(s: AttachmentsSettings): boolean {
  try {
    const endpoint = new URL(s.endpoint.trim());
    return endpoint.port !== "" || /^\d+\.\d+\.\d+\.\d+$/.test(endpoint.hostname);
  } catch {
    return false;
  }
}

const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A presigned PUT for one key: the bucket checks the signature, and never sees the secret. */
export async function presignPut(s: AttachmentsSettings, key: string, at = new Date()): Promise<string> {
  if (!attachmentsReady(s)) throw new AttachError("not-configured");
  const { host, path, secure } = targetFor(s, key);
  const amzDate = stamp(at);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${s.region.trim()}/${SERVICE}/aws4_request`;
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
  const signature = hex(await hmac(await signingKey(s.secretKey.trim(), date, s.region.trim()), stringToSign));
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
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new AttachError("refused", request.status)));
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
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} КБ`;
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

/** Puts a small object in and reads it back: the whole way a photo takes, in a second. */
export async function testBucket(s: AttachmentsSettings): Promise<{ ms: number }> {
  if (!attachmentsReady(s)) throw new AttachError("not-configured");
  const started = performance.now();
  const key = `t/${shortId()}.txt`;
  const url = await presignPut(s, key);
  await putBytes(url, new Blob(["ommesh"], { type: "text/plain" }), "ommesh-test.txt", () => undefined, new AbortController().signal, "text/plain");
  // What the reader sees is the public address, so it is the one checked.
  const answer = await fetch(linkFor(key, s), { method: "GET", cache: "no-store" }).catch(() => null);
  if (!answer || !answer.ok) throw new AttachError("read", answer?.status ?? 0);
  return { ms: Math.round(performance.now() - started) };
}
