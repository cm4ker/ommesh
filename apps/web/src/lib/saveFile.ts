/**
 * A file handed to the reader. The phone app writes it to its cache and
 * opens the system's share sheet, so it can go to a messenger, a drive or
 * the Files app; a browser and the desktop download it.
 */

import { isCapacitor } from "./platform.js";

interface FilesystemPlugin {
  writeFile(options: { path: string; data: string; directory: "CACHE"; encoding: "utf8"; recursive?: boolean }): Promise<{ uri: string }>;
}
interface SharePlugin {
  share(options: { title?: string; files?: string[]; dialogTitle?: string }): Promise<unknown>;
}

// Kept here and never resolved from a Promise: a plugin is a proxy that answers `then` (see phonePosition.ts).
let files: FilesystemPlugin | null = null;
let share: SharePlugin | null = null;

/** How the file went: to the share sheet, or downloaded. Throws when it could not be written. */
export async function saveFile(name: string, text: string, type: string, dialogTitle: string): Promise<"shared" | "downloaded"> {
  if (isCapacitor()) {
    const { registerPlugin } = await import("@capacitor/core");
    files ??= registerPlugin<FilesystemPlugin>("Filesystem");
    share ??= registerPlugin<SharePlugin>("Share");
    const { uri } = await files.writeFile({ path: `exports/${name}`, data: text, directory: "CACHE", encoding: "utf8", recursive: true });
    try {
      await share.share({ title: name, files: [uri], dialogTitle });
    } catch (error) {
      // Put away without picking anything: nothing went wrong.
      if (/cancel/i.test(String((error as { message?: unknown })?.message ?? error))) return "shared";
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
