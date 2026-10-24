/**
 * A file or a text handed to the reader. The phone app opens the system's
 * share sheet, so it can go to a messenger, a drive or the Files app, a file
 * written to its cache first; a browser and the desktop download a file, and
 * share a text where the browser has a share sheet of its own.
 */

import { isCapacitor } from "./platform.js";

interface FilesystemPlugin {
  writeFile(options: { path: string; data: string; directory: "CACHE"; encoding: "utf8"; recursive?: boolean }): Promise<{ uri: string }>;
}
interface SharePlugin {
  share(options: { title?: string; text?: string; files?: string[]; dialogTitle?: string }): Promise<unknown>;
}

// Kept here and never resolved from a Promise: a plugin is a proxy that answers `then` (see phonePosition.ts).
let files: FilesystemPlugin | null = null;
let share: SharePlugin | null = null;

async function sharePlugin(): Promise<SharePlugin> {
  const { registerPlugin } = await import("@capacitor/core");
  share ??= registerPlugin<SharePlugin>("Share");
  return share;
}

/** Whether the share sheet was put away without picking anything, which is no error. */
function putAway(error: unknown): boolean {
  return (error as { name?: unknown })?.name === "AbortError" || /cancel/i.test(String((error as { message?: unknown })?.message ?? error));
}

/** How the file went: to the share sheet, downloaded, or nowhere when the share sheet was put away. Throws when it could not be written. */
export async function saveFile(name: string, text: string, type: string, dialogTitle: string): Promise<"shared" | "downloaded" | "cancelled"> {
  if (isCapacitor()) {
    const { registerPlugin } = await import("@capacitor/core");
    files ??= registerPlugin<FilesystemPlugin>("Filesystem");
    const { uri } = await files.writeFile({ path: `exports/${name}`, data: text, directory: "CACHE", encoding: "utf8", recursive: true });
    try {
      await (await sharePlugin()).share({ title: name, files: [uri], dialogTitle });
    } catch (error) {
      if (putAway(error)) return "cancelled";
      throw error;
    }
    return "shared";
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded";
}

/** Whether a text can go to another app through a share sheet: on a phone, and in a browser that has one. */
export function canShareText(): boolean {
  return isCapacitor() || typeof navigator.share === "function";
}

/** A text to another app, a messenger or notes, through the share sheet; nothing happens when it is put away. */
export async function shareText(text: string): Promise<void> {
  try {
    if (isCapacitor()) await (await sharePlugin()).share({ text });
    else await navigator.share({ text });
  } catch (error) {
    if (!putAway(error)) throw error;
  }
}
