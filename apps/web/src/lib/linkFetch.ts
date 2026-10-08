/**
 * The fetch behind a link preview, from whichever shell carries one. A web
 * view cannot read another site, and should not: the shell's native code does,
 * with the rules of `crates/link-fetch` (the open internet only, checked after
 * every name lookup and redirect; no cookies; small reads). The desktop calls
 * that crate through a Tauri command, the iPhone through the radio core's
 * bindings (`LinkFetchPlugin.swift`). Android and a plain browser have none yet,
 * and so no previews.
 */

import { nativePlatform, shell } from "./platform.js";

/** What a link's address answered. */
export interface Fetched {
  /** The address that answered, after its redirects. */
  url: string;
  status: number;
  contentType: string;
  length: number | null;
  disposition: string | null;
  /** The start of a page or a whole picture, else empty. */
  body: Uint8Array;
  /** The page went on past what was read, or the picture was too large to read. */
  cut: boolean;
}

/** Why nothing was fetched: `address`, `redirects`, `status 404`, `timeout` or `network: …`, as the native side says it. */
export class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface Raw {
  url: string;
  status: number;
  contentType: string;
  length?: number | null;
  disposition?: string | null;
  body: string;
  cut: boolean;
}

interface LinkFetchPlugin {
  fetch(options: { url: string; picture: boolean }): Promise<Raw>;
}

let plugin: LinkFetchPlugin | null = null;

/** Whether this shell can fetch a preview at all; the setting is offered only where it can. */
export function linkFetchAvailable(): boolean {
  const where = shell();
  if (where === "tauri") return true;
  if (where === "capacitor") return nativePlatform() === "ios";
  // The dev server's own answers, for working on the cards without a phone.
  return import.meta.env.DEV;
}

function bytes(base64: string): Uint8Array {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function reasonOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "network";
}

/** Fetches what `url` leads to: a page or a picture, or with `picture` only a picture. Throws `Refused`. */
export async function linkFetch(url: string, picture: boolean): Promise<Fetched> {
  let raw: Raw;
  try {
    const where = shell();
    if (where === "tauri") {
      const { invoke } = await import("@tauri-apps/api/core");
      raw = await invoke<Raw>("link_fetch", { url, picture });
    } else if (where === "capacitor") {
      if (!plugin) {
        const { registerPlugin } = await import("@capacitor/core");
        plugin = registerPlugin<LinkFetchPlugin>("LinkFetch");
      }
      raw = await plugin.fetch({ url, picture });
    } else if (import.meta.env.DEV) {
      const { demoFetch } = await import("./linkFetchDemo.js");
      raw = await demoFetch(url, picture);
    } else {
      throw new Refused("network");
    }
  } catch (error) {
    throw error instanceof Refused ? error : new Refused(reasonOf(error));
  }
  return { url: raw.url, status: raw.status, contentType: raw.contentType, length: raw.length ?? null, disposition: raw.disposition ?? null, body: bytes(raw.body), cut: raw.cut };
}
