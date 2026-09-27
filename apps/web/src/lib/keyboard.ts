import { isCapacitor, nativePlatform } from "./platform.js";

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
 * second (`--keyboard-rise`, styles.css), so they rise with the keyboard.
 *
 * The plugin hears every keyboard in the app, the one a system prompt brings up
 * too (the Bluetooth PIN on a reconnect), and drops its "will hide" when a
 * "will show" follows at once. So the page makes room only while one of its own
 * fields has the focus, and gives it back on anything that says the keyboard is
 * gone: its "did hide", the field losing the focus, the app going away.
 *
 * A screen that has said it moves for the keyboard itself (`moveForKeyboard`)
 * gets the height instead, while the field is in it, and the app keeps its size.
 */
export function followKeyboard(): void {
  const root = document.documentElement;
  root.classList.add("keyboard-follows");
  let shrunk = 0;
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
  };
  const shown = (event: Event) => set(typing() ? ((event as Event & { keyboardHeight?: number }).keyboardHeight ?? 0) : 0);
  // The plugin's window events carry the height on the event itself.
  window.addEventListener("keyboardWillShow", shown);
  window.addEventListener("keyboardDidShow", shown);
  window.addEventListener("keyboardWillHide", () => set(0));
  window.addEventListener("keyboardDidHide", () => set(0));
  // A field that loses the focus to nothing else takes the keyboard with it.
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!typing()) set(0);
    }, 50);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") set(0);
  });
  // A field lower than the room the keyboard leaves comes into view once the keyboard is up.
  window.addEventListener("keyboardDidShow", () => {
    const field = document.activeElement;
    if (typing() && field instanceof HTMLElement) field.scrollIntoView({ block: "nearest" });
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
  const root = document.documentElement;
  root.classList.add("keyboard-heard");
  const up = (on: boolean) => root.classList.toggle("keyboard-up", on);
  window.addEventListener("keyboardWillShow", () => up(true));
  window.addEventListener("keyboardDidShow", () => up(true));
  window.addEventListener("keyboardWillHide", () => up(false));
  window.addEventListener("keyboardDidHide", () => up(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") up(false);
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

/** Whether one of the page's own fields has the focus, so that the keyboard up is the page's. */
function typing(): boolean {
  const field = document.activeElement;
  return field instanceof HTMLElement && (field.isContentEditable || field.matches("input, textarea, select"));
}
