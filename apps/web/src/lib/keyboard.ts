import { isCapacitor, nativePlatform } from "./platform.js";

export interface KeyboardState {
  open: boolean;
  height: number;
}

const keyboardListeners = new Set<(state: KeyboardState) => void>();
let keyboardState: KeyboardState = { open: false, height: 0 };
let nativeKeyboardActive = false;
let iframeTyping = false;
let onIframeTypingChanged: ((active: boolean) => void) | null = null;
let stopVisualViewport: (() => void) | null = null;

function emitKeyboard(open: boolean, height: number): void {
  const h = open ? Math.max(0, Math.round(height)) : 0;
  if (keyboardState.open === open && keyboardState.height === h) return;
  keyboardState = { open, height: h };
  for (const listener of keyboardListeners) listener(keyboardState);
}

/** Current soft-keyboard visibility and height reported by the shell or visualViewport. */
export function getKeyboardState(): KeyboardState {
  return keyboardState;
}

/** Subscribes to soft-keyboard open/height updates on iOS, Android and mobile browsers. */
export function subscribeKeyboard(listener: (state: KeyboardState) => void): () => void {
  keyboardListeners.add(listener);
  if (!nativeKeyboardActive && !stopVisualViewport && typeof window !== "undefined" && window.visualViewport) {
    const vv = window.visualViewport;
    const coarse = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const update = () => {
      if (!coarse()) {
        emitKeyboard(false, 0);
        return;
      }
      const shrink = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // Ignore small browser chrome shifts; a soft keyboard is at least ~120 px tall.
      const open = shrink >= 120;
      emitKeyboard(open, open ? shrink : 0);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    stopVisualViewport = () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      stopVisualViewport = null;
    };
  }
  return () => {
    keyboardListeners.delete(listener);
    if (keyboardListeners.size === 0 && stopVisualViewport) stopVisualViewport();
  };
}

/**
 * Tells keyboard tracking whether an editable field inside a sandboxed mini-app
 * iframe currently holds focus. On iOS, `document.activeElement` in the host is
 * the `<iframe>` itself, so without this signal `followKeyboard()` would ignore
 * the keyboard and leave it covering the mini-app.
 */
export function setIframeTyping(active: boolean): void {
  if (iframeTyping === active) return;
  iframeTyping = active;
  onIframeTypingChanged?.(active);
}

/**
 * On iOS the page follows the keyboard itself.
 *
 * Capacitor's Keyboard plugin could shrink the web view instead ("native"), but
 * it waits until the keyboard has finished rising, plus a fifth of a second,
 * and then shrinks it in one step: the keyboard slides over the conversation,
 * and only afterwards does the conversation jump up. Here the plugin leaves the
 * web view alone (`resize: "none"`, capacitor.config.ts) and reports the
 * keyboard's height as the keyboard starts to move. `--keyboard` takes it at
 * once, and the app and the fixed layers follow over the keyboard's own quarter
 * second (`--keyboard-rise`, styles/base.css), so they rise with the keyboard.
 *
 * The plugin hears every keyboard in the app, the one a system prompt brings up
 * too (the Bluetooth PIN on a reconnect), and drops its "will hide" when a
 * "will show" follows at once. So the page makes room only while one of its own
 * fields (or an active input inside a mini-app iframe) has the focus, and gives
 * it back on anything that says the keyboard is gone: its "did hide", the field
 * losing the focus, the app going away.
 *
 * A screen that has said it moves for the keyboard itself (`moveForKeyboard`)
 * gets the height instead, while the field is in it, and the app keeps its size.
 *
 * Either way `keyboard-open` on the document says the keyboard is up, here and
 * on Android (`watchKeyboard`), for the rules that give it room
 * (styles/sideways.css).
 */
export function followKeyboard(): void {
  nativeKeyboardActive = true;
  if (stopVisualViewport) stopVisualViewport();
  const root = document.documentElement;
  root.classList.add("keyboard-follows");
  let shrunk = 0;
  let lastReportedHeight = 0;
  const set = (height: number) => {
    const field = document.activeElement;
    const mover = height > 0 && field ? ([...movers.keys()].find((el) => el.contains(field)) ?? null) : null;
    if (moved && moved !== mover) movers.get(moved)?.(0);
    moved = mover;
    if (mover) movers.get(mover)!(Math.round(height));
    const shrink = mover ? 0 : Math.max(0, Math.round(height));
    // Set only when it changes: a new value restyles the whole page.
    if (shrink !== shrunk) root.style.setProperty("--keyboard", `${shrink}px`);
    shrunk = shrink;
    root.classList.toggle("keyboard-open", height > 0);
    emitKeyboard(height > 0, height);
  };
  const shown = (event: Event) => {
    const h = Math.max(0, Math.round((event as Event & { keyboardHeight?: number }).keyboardHeight ?? 0));
    lastReportedHeight = h;
    set(typing() ? h : 0);
  };
  const hidden = () => {
    lastReportedHeight = 0;
    set(0);
  };
  onIframeTypingChanged = (active) => {
    if (active) {
      if (lastReportedHeight > 0) set(lastReportedHeight);
    } else {
      setTimeout(() => {
        if (!typing()) set(0);
      }, 50);
    }
  };
  // The plugin's window events carry the height on the event itself.
  window.addEventListener("keyboardWillShow", shown);
  window.addEventListener("keyboardDidShow", shown);
  window.addEventListener("keyboardWillHide", hidden);
  window.addEventListener("keyboardDidHide", hidden);
  // A field that loses the focus to nothing else takes the keyboard with it.
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!typing()) set(0);
    }, 50);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hidden();
  });
  // A field lower than the room the keyboard leaves comes into view once the keyboard is up.
  window.addEventListener("keyboardDidShow", () => {
    const field = document.activeElement;
    if (typing() && field instanceof HTMLElement && field.tagName !== "IFRAME") {
      field.scrollIntoView({ block: "nearest" });
    }
  });
}

const movers = new Map<HTMLElement, (height: number) => void>();
let moved: HTMLElement | null = null;

/**
 * Lets a screen make room for the keyboard itself, where the page follows it
 * (iOS): while a field in `el` has the focus, `move` hears the keyboard's
 * height, and 0 when it goes, and the app is not shrunk. The chat rises by a
 * transform, which the phone animates off the page's thread; shrinking the app
 * lays it out again on every frame. Returns the way to stop.
 */
export function moveForKeyboard(el: HTMLElement, move: (height: number) => void): () => void {
  movers.set(el, move);
  return () => {
    movers.delete(el);
    if (moved === el) moved = null;
  };
}

/**
 * On Android the web view shrinks for the keyboard itself, and the page only
 * needs to know whether the keyboard is up. The focus does not say: a field
 * keeps it after Back or the keyboard's own ˅ has put the keyboard away, and a
 * composer that took that for a keyboard gave up its room above the buttons at
 * the foot of the screen and sat under them.
 */
export function watchKeyboard(): void {
  nativeKeyboardActive = true;
  if (stopVisualViewport) stopVisualViewport();
  const root = document.documentElement;
  root.classList.add("keyboard-heard");
  const up = (on: boolean, height = 0) => {
    root.classList.toggle("keyboard-up", on);
    root.classList.toggle("keyboard-open", on);
    emitKeyboard(on, height);
  };
  const shown = (event: Event) => {
    const h = Math.max(0, Math.round((event as Event & { keyboardHeight?: number }).keyboardHeight ?? 0));
    up(true, h);
  };
  window.addEventListener("keyboardWillShow", shown);
  window.addEventListener("keyboardDidShow", shown);
  window.addEventListener("keyboardWillHide", () => up(false, 0));
  window.addEventListener("keyboardDidHide", () => up(false, 0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") up(false, 0);
  });
}

// Kept as it is, never handed to a promise: a plugin answers every name, `then` too, so a promise
// resolved with it calls the native side for "then" and never settles.
let keyboard: { show: () => Promise<void> } | null = null;

/**
 * Brings Android's keyboard up for the field that has just taken the focus.
 * The web view raises it itself for a focus that follows a tap, but not always
 * for one that follows a swipe: after the page had been loaded again from the
 * native side, a reply swiped as the first touch got the caret and no
 * keyboard. Elsewhere the focus is enough, and iOS has no such call.
 */
export function raiseKeyboard(): void {
  if (!isCapacitor() || nativePlatform() !== "android" || !typing()) return;
  void import("@capacitor/core")
    .then(({ registerPlugin }) => {
      keyboard ??= registerPlugin<{ show: () => Promise<void> }>("Keyboard");
      return keyboard.show();
    })
    .catch(() => undefined);
}

/** Whether one of the page's own fields (or a mini-app iframe input) has the focus. */
function typing(): boolean {
  if (iframeTyping) return true;
  const field = document.activeElement;
  return field instanceof HTMLElement && (field.isContentEditable || field.matches("input, textarea, select"));
}
