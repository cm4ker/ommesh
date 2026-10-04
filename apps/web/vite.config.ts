import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

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
  plugins: [react()],
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
