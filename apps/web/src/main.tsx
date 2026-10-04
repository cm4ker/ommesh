import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { goBack } from "./lib/back.js";
import { followKeyboard, watchKeyboard } from "./lib/keyboard.js";
import { autoConnect, connectWith, disconnect, getLink } from "./lib/link.js";
import { linkBook, startLinks } from "./lib/links.js";
import { registerNews } from "./lib/news.js";
import { getPing } from "./lib/ping.js";
import { isCapacitor, nativePlatform } from "./lib/platform.js";
import { initSendTries } from "./lib/sendTries.js";
import { session } from "./lib/session.js";
import { connectors } from "./transports/index.js";
import { initTheme } from "./theme/store.js";
import { initTextSize } from "./theme/textSize.js";
import { initLanguage } from "./i18n/index.js";
import "./i18n/languages.js";
import "./styles.css";

// For the console, and for driving the shell from a test rig: the session,
// the link, the connectors and what the radio has heard of the mesh, under one name. Android's shell calls `back`
// on its Back button (MainActivity).
Object.assign(window, { meshnet: { session, getLink, connectWith, disconnect, connectors, back: goBack, linkBook, getPing } });

// Who hears whom, from every packet the radio hands up, for finding a way through the mesh.
startLinks();

// What each version brought, carried with the app. Before anything is drawn or moved about in, so a first
// launch is told from an update (news.ts) and an update puts its strip over the chats.
registerNews(Object.values(import.meta.glob("./news/*.json", { eager: true, import: "default" })));

// How many times a direct message goes before it is given up on: the session needs it before the first send.
initSendTries();

// Before the first render, so the page never paints in one palette or one text size and resolves
// into another.
initTheme();
initTextSize();
// The words, in the reader's language, are loaded before anything is drawn in them.
await initLanguage();

// In the phone app the page is the whole app, laid out to the screen, and a
// pinch that zooms it only leaves it scrolling sideways. The same cap stops
// iOS zooming in on a field it thinks too small to type in. A browser tab
// keeps its zoom.
if (isCapacitor()) {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content += ", maximum-scale=1, user-scalable=no";
}

// The page is laid out to the screen and never scrolls as a whole. On iOS it
// makes room for the keyboard itself, rising as the keyboard does
// (lib/keyboard.ts). Should iOS still scroll the page to bring a field above the
// keyboard, which would leave the header above the top of the screen, it goes
// straight back.
if (nativePlatform() === "ios") {
  followKeyboard();
  window.addEventListener("scroll", () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }, { passive: true });
} else if (nativePlatform() === "android") {
  watchKeyboard();
}

// The last radio's chats, read from the storage before the first paint when
// they come in time: the app opens on them, not on the connect screen, and the
// link is reached for behind them. A storage slow to answer holds it no longer.
await Promise.race([autoConnect().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 400))]);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
