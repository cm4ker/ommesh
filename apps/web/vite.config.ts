import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * index.html tells a phone whose web view is too old for the client what to update. It cannot load
 * the client's words, so the `oldWebView.*` lines of each language's app.json are written into it.
 */
const oldWebViewWords: Plugin = {
  name: "old-webview-words",
  transformIndexHtml(html) {
    const i18n = new URL("src/i18n/", import.meta.url);
    const words: Record<string, Record<string, unknown>> = {};
    for (const entry of readdirSync(i18n, { withFileTypes: true })) {
      const file = new URL(`${entry.name}/app.json`, i18n);
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const app = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      words[entry.name] = Object.fromEntries(Object.entries(app).filter(([key]) => key.startsWith("oldWebView.")));
    }
    // "<" goes in as <, so no word can close the script it is written into.
    return html.replace("__OLD_WEBVIEW_WORDS__", JSON.stringify(words).replace(/</g, "\\u003c"));
  },
};

/**
 * `base: "./"` because the same build is opened three ways — from a web
 * server, from `tauri://localhost`, and from `capacitor://localhost` — and a
 * root-relative asset path is only right for the first.
 *
 * The dev server is reachable on the LAN so a phone shell can be pointed at
 * it during development (`CAP_SERVER_URL`), and its port is what the Tauri
 * config's `devUrl` names.
 */
export default defineConfig({
  plugins: [react(), oldWebViewWords],
  base: "./",
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(process.env["MESHNET_VERSION"] ?? version),
    // apps/mobile/scripts/android.mjs sets it for the bundle that goes to Google Play.
    __FOR_PLAY__: JSON.stringify(process.env["MESHNET_FOR_PLAY"] === "1"),
  },
  build: {
    // The oldest web view the client runs in is Safari 15, the iOS app's lowest version
    // (IPHONEOS_DEPLOYMENT_TARGET): newer syntax is written the old way for it.
    target: ["es2022", "safari15"],
    outDir: "dist",
    rollupOptions: {
      // The app, and the desktop shell's corner window for its own notices (notices.rs).
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        notices: fileURLToPath(new URL("notices.html", import.meta.url)),
      },
    },
  },
  server: {
    // 5180, not Vite's 5173: sovabox's dev server usually holds that on this machine.
    port: 5180,
    strictPort: true,
    host: true,
  },
});
