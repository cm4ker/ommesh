import { useSyncExternalStore } from "react";
import { backgroundOf, backgroundPrefs, useBackgroundPrefs, type Background } from "../lib/chatBackground.js";
import { getActiveTheme, subscribeTheme } from "../theme/store.js";

/**
 * Seamless pictures made by `pnpm backgrounds`, ready drawn. Their SVG drawings stay out of
 * the app: an SVG of a thousand shapes and more took an old phone two seconds to draw, and the
 * browser drew it again whenever the chat was painted. A picture is decoded off the page's
 * thread and only scaled after that.
 */
const FILES = import.meta.glob("../backgrounds/*.webp", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The widths each picture comes in, in pixels. */
const WIDTHS = [400, 800, 1200];

const fileOf = (background: Background, appearance: string, width: number) => FILES[`../backgrounds/${background}-${appearance}-${width}.webp`];

/**
 * The picture shown `shown` CSS pixels wide, as a set the browser picks from for its screen's
 * density: one much bigger than needed, squeezed, breaks up thin lines.
 */
function pictureSet(background: Background, appearance: string, shown: number): string {
  return `image-set(${WIDTHS.map((width) => `url("${fileOf(background, appearance, width)}") ${width / shown}x`).join(", ")})`;
}

/**
 * The picture behind a chat, under its messages: everyone's or the chat's own, or the one
 * named by `background` for a sample. Nothing at all for no picture, so a chat without one
 * is drawn exactly as before.
 */
export function ChatBackdrop({
  conversation,
  background,
  scale = 1,
  swatch = false,
}: {
  conversation?: string;
  background?: Background;
  scale?: number;
  swatch?: boolean;
}) {
  const prefs = useBackgroundPrefs();
  const theme = useSyncExternalStore(subscribeTheme, getActiveTheme);
  const picked = background ?? backgroundOf(prefs, conversation);
  if (picked === "none") return null;
  // Swatches stay recognisable at zero intensity; the sample shows the actual setting.
  const size = Math.round(400 * scale * (swatch ? 1 : prefs.scale / 100));
  return (
    <div className="chat-backdrop" data-bg={picked} aria-hidden="true">
      <i
        className="bg-picture"
        style={{
          backgroundImage: pictureSet(picked, theme.appearance, size),
          backgroundSize: `${size}px auto`,
          opacity: swatch ? 1 : prefs.strength / 100,
        }}
      />
    </div>
  );
}

/** Held so the decoded picture is not thrown away before a chat shows it. */
let warmed: HTMLImageElement | undefined;

/** Loads and decodes everyone's picture ahead of time, so the first chat opened shows it at once. */
export function warmBackdrop(): void {
  const { background, scale } = backgroundPrefs();
  if (background === "none") return;
  // The one the browser takes from the set: the first wide enough for the screen, or the widest.
  const needed = (400 * scale * devicePixelRatio) / 100;
  const url = fileOf(background, getActiveTheme().appearance, WIDTHS.find((width) => width >= needed) ?? 1200);
  if (url === undefined) return;
  warmed = new Image();
  warmed.src = url;
  warmed.decode().catch(() => undefined);
}
