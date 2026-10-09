/**
 * A chat's avatar as a PNG, for the phone's share sheet (#88), which draws
 * pictures, not the page's markup. The avatar is drawn by the page once, out of
 * sight, so the picture has the colours and glyph the chat list shows; the
 * system rounds it off itself. The glyph keeps to the middle two thirds:
 * Android cuts an adaptive icon's edges away.
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Avatar } from "../components/Avatar.js";
import type { ChannelAccess } from "./channels.js";

const SIZE = 192;

export interface AvatarOf {
  name: string;
  type?: number | undefined;
  channel?: ChannelAccess | undefined;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("avatar glyph did not load"));
    image.src = src;
  });
}

/** The PNG's base64, without the `data:` head. */
export async function avatarImage(of: AvatarOf): Promise<string> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-1000px;top:0;pointer-events:none";
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(Avatar, { ...of, size: SIZE })));
    const swatch = host.querySelector<HTMLElement>(".avatar");
    if (!swatch) throw new Error("avatar not drawn");
    const style = getComputedStyle(swatch);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no canvas");
    g.fillStyle = style.backgroundColor;
    g.fillRect(0, 0, SIZE, SIZE);
    const icon = swatch.querySelector("svg");
    if (icon) {
      // An icon draws in currentColor: its colour goes in, and it is drawn as an image of its own.
      const copy = icon.cloneNode(true) as SVGSVGElement;
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copy.setAttribute("color", style.color);
      const side = SIZE * 0.42;
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(copy.outerHTML)}`);
      g.drawImage(image, (SIZE - side) / 2, (SIZE - side) / 2, side, side);
    } else {
      const text = swatch.textContent ?? "";
      g.fillStyle = style.color;
      g.font = `600 ${parseFloat(style.fontSize) * 0.85}px ${style.fontFamily}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, SIZE / 2, SIZE / 2 + SIZE * 0.02);
    }
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  } finally {
    root.unmount();
    host.remove();
  }
}
