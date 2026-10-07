import { useSyncExternalStore, type CSSProperties } from "react";
import { backgroundOf, useBackgroundPrefs, type Background } from "../lib/chatBackground.js";
import { getActiveTheme, subscribeTheme } from "../theme/store.js";

/** The drawn tiles (`pnpm backgrounds`), by file name. */
const FILES = import.meta.glob("../backgrounds/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const file = (name: string) => `url("${FILES[`../backgrounds/${name}.svg`] ?? ""}")`;

/**
 * How each picture is laid: a mask painted in the theme's text and accent colours, or a
 * picture in its own colours with a dark and a light version. `size` is the tile, or
 * "cover" for one drawn to fill the screen; `strength` is how strong it is drawn at the
 * slider's middle, on a dark theme and a light one.
 */
const LOOKS: Record<Exclude<Background, "none">, { kind: "mask" | "picture"; size: number | "cover"; strength: [number, number] }> = {
  callsigns: { kind: "mask", size: 300, strength: [0.32, 0.34] },
  network: { kind: "mask", size: 320, strength: [0.34, 0.32] },
  topo: { kind: "mask", size: 360, strength: [0.34, 0.36] },
  geometry: { kind: "mask", size: 312, strength: [0.5, 0.45] },
  ether: { kind: "mask", size: "cover", strength: [0.45, 0.4] },
  space: { kind: "picture", size: 420, strength: [1, 0.85] },
  stitch: { kind: "picture", size: 192, strength: [0.9, 0.85] },
  aurora: { kind: "picture", size: "cover", strength: [1, 1] },
};

/**
 * The picture behind a chat, under its messages: everyone's or the chat's own, or the one
 * named by `background` for a sample. Nothing at all for no picture, so a chat without one
 * is drawn exactly as before.
 */
export function ChatBackdrop({ conversation, background, scale = 1 }: { conversation?: string; background?: Background; scale?: number }) {
  const prefs = useBackgroundPrefs();
  const theme = useSyncExternalStore(subscribeTheme, getActiveTheme);
  const picked = background ?? backgroundOf(prefs, conversation);
  if (picked === "none") return null;
  const look = LOOKS[picked];
  const dark = theme.appearance === "dark";
  const opacity = Math.min(1, look.strength[dark ? 0 : 1] * (prefs.strength / 50));
  const size = look.size === "cover" ? "cover" : `${Math.round(look.size * scale)}px`;
  const layer = (image: string, mask: boolean): CSSProperties =>
    mask ? { WebkitMaskImage: image, maskImage: image, WebkitMaskSize: size, maskSize: size, opacity } : { backgroundImage: image, backgroundSize: size, opacity };
  return (
    <div className="chat-backdrop" data-bg={picked} aria-hidden="true">
      {look.kind === "mask" ? (
        <>
          <i className="bg-base" style={layer(file(`${picked}-base`), true)} />
          <i className="bg-accent" style={layer(file(`${picked}-accent`), true)} />
        </>
      ) : (
        <i className="bg-picture" style={layer(file(`${picked}-${dark ? "dark" : "light"}`), false)} />
      )}
    </div>
  );
}
