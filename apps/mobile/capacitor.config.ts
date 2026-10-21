import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The phone shell carries the built client (`apps/web/dist`), unlike a mail
 * client that has a server to load its pages from: a radio in a field has no
 * network, and the app must open without one.
 *
 * `CAP_SERVER_URL` points a development build at a running `pnpm web` on the
 * LAN instead, so a change is on the phone on save.
 */
const config: CapacitorConfig = {
  appId: "dev.cm4ker.meshnet",
  appName: "Ommesh",
  webDir: "../web/dist",
  backgroundColor: "#282c33",
  // OpenStreetMap's tile policy asks every client to say who it is; the map's tiles go out with this.
  appendUserAgent: "Ommesh (+https://github.com/cm4ker/ommesh)",
  ios: {
    // The client lays itself out under the notch with `env(safe-area-inset-*)`; an inset here would count it twice.
    contentInset: "never",
    allowsLinkPreview: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: Boolean(process.env["CAP_SERVER_URL"]),
  },
  plugins: {
    // Android: the page asks for viewport-fit=cover, but SystemBars learns that only once the page
    // is up, and until then pads the window below the bars; when it stops, the page jumped under
    // the clock for a moment at every start. Told beforehand, it never pads.
    SystemBars: {
      initialViewportFitValueHint: "cover",
    },
    LocalNotifications: {
      smallIcon: "ic_stat_meshnet",
      iconColor: "#74ade8",
    },
    // iOS: the page makes room for the keyboard itself, rising with it (apps/web/src/lib/keyboard.ts).
    // "native" would shrink the web view instead, but only once the keyboard is up, plus a fifth of
    // a second, in one step, so the keyboard first slid over the conversation and then the
    // conversation jumped. The plugin still takes the web view's own keyboard handling away, which
    // is what scrolled the whole page, header and all, to show a field.
    Keyboard: {
      resize: "none",
      resizeOnFullScreen: true,
    },
    BluetoothLe: {
      displayStrings: {
        scanning: "Looking for radios",
        cancel: "Cancel",
        availableDevices: "Radios",
        noDeviceFound: "No radio found",
      },
    },
  },
  ...(process.env["CAP_SERVER_URL"] ? { server: { url: process.env["CAP_SERVER_URL"], cleartext: true } } : {}),
};

export default config;
