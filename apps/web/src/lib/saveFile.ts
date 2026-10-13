/**
 * A file handed to the reader. The phone app writes it to its cache and
 * opens the system's share sheet, so it can go to a messenger, a drive or
 * the Files app; a browser and the desktop download it.
 */

import { isCapacitor } from "./platform.js";

interface FilesystemPlugin {
  /** Without an encoding the data is base64, which is how a file of bytes goes. */
  writeFile(options: { path: string; data: string; directory: "CACHE"; encoding?: "utf8"; recursive?: boolean }): Promise<{ uri: string }>;
}
interface SharePlugin {
  share(options: { title?: string; files?: string[]; dialogTitle?: string }): Promise<unknown>;
}

// Kept here and never resolved from a Promise: a plugin is a proxy that answers `then` (see phonePosition.ts).
let files: FilesystemPlugin | null = null;
let share: SharePlugin | null = null;

/** How the file went: to the share sheet, or downloaded. Throws when it could not be written. Text, or bytes (a voice card). */
export async function saveFile(name: string, content: string | Uint8Array, type: string, dialogTitle: string): Promise<"shared" | "downloaded"> {
  if (isCapacitor()) {
    const { registerPlugin } = await import("@capacitor/core");
    files ??= registerPlugin<FilesystemPlugin>("Filesystem");
    share ??= registerPlugin<SharePlugin>("Share");
    const written =
      typeof content === "string"
        ? { data: content, encoding: "utf8" as const }
        : { data: btoa(Array.from(content, (b) => String.fromCharCode(b)).join("")) };
    const { uri } = await files.writeFile({ path: `exports/${name}`, directory: "CACHE", recursive: true, ...written });
    try {
      await share.share({ title: name, files: [uri], dialogTitle });
    } catch (error) {
      // Put away without picking anything: nothing went wrong.
      if (/cancel/i.test(String((error as { message?: unknown })?.message ?? error))) return "shared";
      throw error;
    }
    return "shared";
  }
  const url = URL.createObjectURL(new Blob([typeof content === "string" ? content : new Uint8Array(content)], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded";
}
