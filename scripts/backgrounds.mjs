/**
 * Draws the chat backgrounds into the web client (`apps/web/src/backgrounds`,
 * which ChatBackdrop imports), as seamless SVG tiles. Most are masks:
 * `<id>-base.svg` and `<id>-accent.svg` say only where the pattern is, and the
 * chat paints them in the theme's text and accent colours, so each fits every theme. Space, Embroidery and Aurora are pictures
 * in their own colours, one for dark themes and one for light, with their
 * ground drawn in. Seeded, so a run draws the same files. Run `pnpm backgrounds`
 * after changing one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/web/src/backgrounds");
mkdirSync(OUT, { recursive: true });

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => (Math.round(n * 10) / 10).toString();
const svg = (w, h, body, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;

/** A mask is drawn in two passes: what the text colour paints, then what the accent paints. */
const BASE = { base: "#000", accent: null };
const ACCENT = { base: null, accent: "#000" };
const PICTURE = {
  dark: { base: "#ffffff", accent: "#74ade8", warm: "#f0a35e", red: "#e0646a", gold: "#d8b46f", teal: "#6cc8bd", ground: "#141834" },
  light: { base: "#1d2b4a", accent: "#4a66d6", warm: "#c96a24", red: "#b8323a", gold: "#9a7424", teal: "#2a8f84", ground: "#ebe8f7" },
};

/** Copies of a shape where it runs over the tile's edge, so the tiles meet without a seam. */
function wrapped(x, y, r, w, h, draw) {
  let out = "";
  for (const dx of [-w, 0, w]) {
    for (const dy of [-h, 0, h]) {
      const cx = x + dx;
      const cy = y + dy;
      if (cx + r < 0 || cx - r > w || cy + r < 0 || cy - r > h) continue;
      out += draw(cx, cy);
    }
  }
  return out;
}
function torusDist(a, b, w, h) {
  let dx = Math.abs(a.x - b.x);
  dx = Math.min(dx, w - dx);
  let dy = Math.abs(a.y - b.y);
  dy = Math.min(dy, h - dy);
  return Math.hypot(dx, dy);
}
function poisson(rand, w, h, count, radiusOf, gap, tries = 6000) {
  const pts = [];
  for (let i = 0; i < tries && pts.length < count; i++) {
    const p = { x: rand() * w, y: rand() * h };
    p.r = radiusOf(rand);
    if (pts.every((q) => torusDist(p, q, w, h) >= p.r + q.r + gap)) pts.push(p);
  }
  return pts;
}

// Call signs: dense doodles of radio things, about a quarter in the accent.
const ICONS = [
  "M12 10v11M9 21l3-11 3 11M7.5 6.5a6 6 0 0 0 0 7M16.5 6.5a6 6 0 0 1 0 7",
  "M7 21 12 5l5 16M9 15h6M10.3 10.5h3.4M4.5 8.5a9 9 0 0 1 3-5M19.5 8.5a9 9 0 0 0-3-5",
  "M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11zM12 8a2 2 0 1 0 .01 0",
  "M3 8h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H3zM23 11v3M6.5 11v3M10 11v3M13.5 11v3",
  "M4 20v-3M9 20v-6M14 20v-9M19 20V7",
  "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
  "M4 5h16v11H9l-5 4V5zM8 9h8M8 12h5",
  "M2 20 9 8l4 6 3-4 6 10z",
  "M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z",
  "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2",
  "M9 4 7 20M17 4l-2 16M4 9h16M3 15h16",
  "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z",
  "M4 14a8 8 0 0 0 12 0M2 10a12 12 0 0 1 20 0M6 6a8 8 0 0 1 12 0M12 14v7M9 21h6",
  "M12 2v4M12 18v4M2 12h4M18 12h4M12 8l2 4-2 4-2-4z",
  "M4 21V10l8-6 8 6v11M9 21v-6h6v6",
  "M5 18a2 2 0 1 0 .01 0M19 18a2 2 0 1 0 .01 0M12 5a2 2 0 1 0 .01 0M6.5 16.5l4.5-9.5M17.5 16.5 13 7M7 19h10",
  "M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0",
  "M8 3h8v18H8zM10 3V1M10 7h4v4h-4zM10 14h1M13 14h1M10 17h1M13 17h1",
  "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  "M12 3a9 9 0 1 0 .01 0M12 7v5l3 2",
  "M5 21V4h11l-2 4 2 4H5",
  "M12 2a10 10 0 1 0 .01 0M2 12h20M12 2c3 3 4.5 6.5 4.5 10S15 19 12 22M12 2C9 5 7.5 8.5 7.5 12S9 19 12 22",
];
function callsigns(ink) {
  const rand = rng(7);
  const W = 300;
  const big = poisson(rand, W, W, 80, (r) => 9 + r() * 5, 5);
  let body = "";
  for (const p of big) {
    const icon = ICONS[Math.floor(rand() * ICONS.length)];
    const size = p.r * 2;
    const rot = (rand() - 0.5) * 70;
    const accent = rand() < 0.26;
    const color = accent ? ink.accent : ink.base;
    if (!color) continue;
    body += wrapped(p.x, p.y, p.r + 2, W, W, (x, y) =>
      `<path d="${icon}" transform="translate(${f(x - size / 2)} ${f(y - size / 2)}) rotate(${f(rot)} ${f(size / 2)} ${f(size / 2)}) scale(${f(size / 24)})" fill="none" stroke="${color}" stroke-opacity="${accent ? 1 : 0.65}" stroke-width="${f((1.35 * 24) / size)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  // Small marks between the doodles, as on the wallpapers this follows.
  const taken = big.map((p) => ({ ...p }));
  for (let i = 0; i < 3000; i++) {
    const p = { x: rand() * W, y: rand() * W, r: 2.2 };
    if (!taken.every((q) => torusDist(p, q, W, W) >= p.r + q.r + 3)) continue;
    taken.push(p);
    const kind = rand();
    const ring = kind >= 0.8 && rand() < 0.5;
    const color = ring ? ink.accent : ink.base;
    if (!color) continue;
    body += wrapped(p.x, p.y, 4, W, W, (x, y) =>
      kind < 0.45
        ? `<circle cx="${f(x)}" cy="${f(y)}" r="1.1" fill="${color}" fill-opacity="0.5"/>`
        : kind < 0.8
          ? `<path d="M${f(x - 2.5)} ${f(y)}h5M${f(x)} ${f(y - 2.5)}v5" stroke="${color}" stroke-opacity="0.5" stroke-width="1" stroke-linecap="round"/>`
          : `<circle cx="${f(x)}" cy="${f(y)}" r="2" fill="none" stroke="${color}" stroke-opacity="0.6" stroke-width="0.9"/>`);
  }
  return svg(W, W, body);
}

// Mesh: nodes joined to their nearest neighbours; hubs in the accent, with rings.
function network(ink) {
  const rand = rng(11);
  const W = 320;
  const pts = poisson(rand, W, W, 120, () => 9, 6);
  for (const p of pts) p.hub = rand() < 0.11;
  const edges = new Set();
  let body = "";
  const near = (i) => pts.map((q, j) => ({ j, d: torusDist(pts[i], q, W, W) })).filter((e) => e.j !== i).sort((a, b) => a.d - b.d);
  pts.forEach((p, i) => {
    for (const { j } of near(i).slice(0, p.hub ? 5 : 3)) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (edges.has(key)) continue;
      edges.add(key);
      const q = pts[j];
      let qx = q.x;
      let qy = q.y;
      if (qx - p.x > W / 2) qx -= W;
      else if (p.x - qx > W / 2) qx += W;
      if (qy - p.y > W / 2) qy -= W;
      else if (p.y - qy > W / 2) qy += W;
      const hot = (p.hub || q.hub) && rand() < 0.55;
      const color = hot ? ink.accent : ink.base;
      if (!color) continue;
      const len = Math.hypot(qx - p.x, qy - p.y);
      body += wrapped((p.x + qx) / 2, (p.y + qy) / 2, len / 2 + 2, W, W, (mx, my) => {
        const ox = mx - (p.x + qx) / 2;
        const oy = my - (p.y + qy) / 2;
        return `<path d="M${f(p.x + ox)} ${f(p.y + oy)}L${f(qx + ox)} ${f(qy + oy)}" stroke="${color}" stroke-opacity="${hot ? 0.9 : 0.45}" stroke-width="${hot ? 1.2 : 0.8}"${hot ? ' stroke-dasharray="3 2.5"' : ""}/>`;
      });
    }
  });
  for (const p of pts) {
    const r = f(1.4 + rand() * 1.2);
    const color = p.hub ? ink.accent : ink.base;
    if (!color) continue;
    body += wrapped(p.x, p.y, 16, W, W, (x, y) =>
      p.hub
        ? `<circle cx="${f(x)}" cy="${f(y)}" r="13" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="0.8"/><circle cx="${f(x)}" cy="${f(y)}" r="6" fill="none" stroke="${color}" stroke-width="1.2"/><circle cx="${f(x)}" cy="${f(y)}" r="2.8" fill="${color}"/>`
        : `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="${color}" fill-opacity="0.75"/>`);
  }
  return svg(W, W, body);
}

// Terrain: contour lines of a periodic height field, by marching squares; every fifth in the accent.
function topo(ink) {
  const rand = rng(5);
  const W = 360;
  const N = 90;
  const waves = Array.from({ length: 7 }, () => ({ kx: Math.floor(rand() * 4) - 1, ky: Math.floor(rand() * 4) - 1, a: 0.4 + rand(), p: rand() * Math.PI * 2 })).filter((w) => w.kx || w.ky);
  const field = (i, j) => {
    const x = i / N;
    const y = j / N;
    let v = 0;
    for (const w of waves) v += w.a * Math.cos(2 * Math.PI * (w.kx * x + w.ky * y) + w.p);
    return v + 0.35 * Math.cos(2 * Math.PI * (3 * x + 2 * y) + 1.3) * Math.cos(2 * Math.PI * (2 * x - 3 * y));
  };
  const g = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = field(i, j);
      g.push(v);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const at = (i, j) => g[((j + N) % N) * N + ((i + N) % N)];
  const cell = W / N;
  const LEVELS = 22;
  let body = "";
  for (let l = 1; l < LEVELS; l++) {
    const index = l % 5 === 0;
    const color = index ? ink.accent : ink.base;
    if (!color) continue;
    const level = lo + (hi - lo) * (l / LEVELS);
    const segs = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        const x = i * cell;
        const y = j * cell;
        const pts = [];
        const lerp = (p, q) => (level - p) / (q - p);
        if (a > level !== b > level) pts.push([x + cell * lerp(a, b), y]);
        if (b > level !== c > level) pts.push([x + cell, y + cell * lerp(b, c)]);
        if (d > level !== c > level) pts.push([x + cell * lerp(d, c), y + cell]);
        if (a > level !== d > level) pts.push([x, y + cell * lerp(a, d)]);
        if (pts.length === 2) segs.push(pts);
        else if (pts.length === 4) segs.push([pts[0], pts[1]], [pts[2], pts[3]]);
      }
    }
    // Segments chained into lines, so the file stays small.
    const key = (p) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`;
    const ends = new Map();
    segs.forEach((s, k) => {
      for (const p of s) {
        const kk = key(p);
        if (!ends.has(kk)) ends.set(kk, []);
        ends.get(kk).push(k);
      }
    });
    const used = new Set();
    let d = "";
    for (let k = 0; k < segs.length; k++) {
      if (used.has(k)) continue;
      used.add(k);
      const line = [...segs[k]];
      for (const forward of [true, false]) {
        for (;;) {
          const tip = forward ? line[line.length - 1] : line[0];
          const next = (ends.get(key(tip)) ?? []).find((m) => !used.has(m));
          if (next === undefined) break;
          used.add(next);
          const [p, q] = segs[next];
          const other = key(p) === key(tip) ? q : p;
          if (forward) line.push(other);
          else line.unshift(other);
        }
      }
      d += "M" + line.map((p) => `${f(p[0])} ${f(p[1])}`).join("L");
    }
    body += `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${index ? 0.85 : 0.5}" stroke-width="${index ? 1.3 : 0.7}" stroke-linejoin="round"/>`;
  }
  return svg(W, W, body);
}

// Geometry: squares, corners and diamonds; about a fifth in the accent.
function geometry(ink) {
  const rand = rng(21);
  const N = 12;
  const S = 26;
  const W = N * S;
  const used = new Set();
  let body = "";
  const stroke = (accent, op = 1) => {
    const color = accent ? ink.accent : ink.base;
    return color ? `fill="none" stroke="${color}" stroke-opacity="${accent ? 0.95 : 0.5 * op}" stroke-width="1.6"` : null;
  };
  const fill = (accent) => {
    const color = accent ? ink.accent : ink.base;
    return color ? `fill="${color}" fill-opacity="${accent ? 0.95 : 0.45}"` : null;
  };
  const shape = (tag, attrs, paint) => (paint ? `<${tag} ${attrs} ${paint}/>` : "");
  for (let k = 0; k < 9; k++) {
    const x = Math.floor(rand() * (N - 1));
    const y = Math.floor(rand() * (N - 1));
    if ([0, 1].some((a) => [0, 1].some((b) => used.has(`${x + a},${y + b}`)))) continue;
    for (const a of [0, 1]) for (const b of [0, 1]) used.add(`${x + a},${y + b}`);
    const px = x * S + 3;
    const py = y * S + 3;
    const s = S * 2 - 6;
    const accent = rand() < 0.35;
    body += shape("rect", `x="${px}" y="${py}" width="${s}" height="${s}"`, stroke(accent));
    body += shape("rect", `x="${px + 8}" y="${py + 8}" width="${s - 16}" height="${s - 16}"`, stroke(!accent));
    body += shape("rect", `x="${px + 16}" y="${py + 16}" width="${s - 32}" height="${s - 32}"`, fill(accent));
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (used.has(`${x},${y}`)) continue;
      const px = x * S;
      const py = y * S;
      const a = rand() < 0.22;
      const m = rand();
      const c = S / 2;
      if (m < 0.16) body += shape("rect", `x="${px + 3}" y="${py + 3}" width="${S - 6}" height="${S - 6}"`, stroke(a)) + shape("rect", `x="${px + 8}" y="${py + 8}" width="${S - 16}" height="${S - 16}"`, stroke(a));
      else if (m < 0.3) body += shape("path", `d="M${px + 3} ${py + S - 3}V${py + 3}H${px + S - 3}M${px + 8} ${py + S - 3}V${py + 8}H${px + S - 3}"`, stroke(a));
      else if (m < 0.42) body += shape("path", `d="M${px + c} ${py + 3}L${px + S - 3} ${py + c}L${px + c} ${py + S - 3}L${px + 3} ${py + c}z"`, stroke(a)) + shape("rect", `x="${px + c - 2.5}" y="${py + c - 2.5}" width="5" height="5"`, fill(a));
      else if (m < 0.54) body += shape("path", `d="M${px + 3} ${py + 7}H${px + S - 3}M${px + 3} ${py + c}H${px + S - 3}M${px + 3} ${py + S - 7}H${px + S - 3}"`, stroke(a));
      else if (m < 0.64) body += shape("path", `d="M${px + 7} ${py + 3}V${py + S - 3}M${px + c} ${py + 3}V${py + S - 3}M${px + S - 7} ${py + 3}V${py + S - 3}"`, stroke(a));
      else if (m < 0.76) body += shape("rect", `x="${px + 4}" y="${py + 4}" width="7" height="7"`, fill(a)) + shape("rect", `x="${px + 15}" y="${py + 4}" width="7" height="7"`, stroke(a)) + shape("rect", `x="${px + 4}" y="${py + 15}" width="7" height="7"`, stroke(a)) + shape("rect", `x="${px + 15}" y="${py + 15}" width="7" height="7"`, fill(a));
      else if (m < 0.86) body += shape("path", `d="M${px + 3} ${py + 3}H${px + S - 3}V${py + S - 3}H${px + 9}V${py + 9}H${px + S - 9}V${py + S - 9}"`, stroke(a));
      else body += shape("rect", `x="${px + 3}" y="${py + 3}" width="${S - 6}" height="${S - 6}"`, stroke(a, 0.6)) + shape("rect", `x="${px + c - 3}" y="${py + c - 3}" width="6" height="6"`, fill(a));
    }
  }
  return svg(W, W, body);
}

// Airwaves: rings from three transmitters crossing into moiré; one picture, not a tile.
function ether(ink) {
  const W = 420;
  const H = 900;
  const sources = [
    [70, 140],
    [350, 420],
    [110, 760],
  ];
  let body = "";
  sources.forEach(([x, y], k) => {
    for (let r = 10; r < 900; r += 10) {
      const hot = r % 60 === 10;
      const color = hot ? ink.accent : ink.base;
      if (!color) continue;
      const op = Math.max(0.12, 1 - r / 900) * (k === 0 ? 1 : 0.85);
      body += `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-opacity="${f(hot ? Math.min(1, op + 0.25) : op)}" stroke-width="${hot ? 1.4 : 0.85}"/>`;
    }
    if (ink.accent) body += `<g transform="translate(${x - 12} ${y - 12})"><circle cx="12" cy="12" r="11" fill="${ink.accent}" fill-opacity="0.25"/><path d="M7 21 12 5l5 16M9 15h6M10.3 10.5h3.4" fill="none" stroke="${ink.accent}" stroke-width="1.6" stroke-linecap="round"/></g>`;
  });
  return svg(W, H, body);
}

// Space: a band of dust, stars, ringed planets with moons; a picture with its ground.
function space(pal) {
  const rand = rng(3);
  const W = 420;
  const colors = [pal.warm, pal.red, pal.teal, pal.accent, pal.gold];
  const defs = colors.map((c, i) => `<radialGradient id="pl${i}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="0.35" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0.55"/></radialGradient>`).join("");
  let body = `<rect width="${W}" height="${W}" fill="${pal.ground}"/>`;
  for (let i = 0; i < 700; i++) {
    const x = rand() * W;
    const yc = W * 0.5 + Math.sin((x / W) * Math.PI * 2) * 70;
    const y = (yc + (rand() + rand() + rand() - 1.5) * 70 + W) % W;
    body += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.3 + rand() * 0.5)}" fill="${pal.base}" fill-opacity="${f(0.15 + rand() * 0.35)}"/>`;
  }
  for (let i = 0; i < 240; i++) {
    const r = rand() < 0.85 ? 0.4 + rand() * 0.7 : 1 + rand() * 0.8;
    const c = rand() < 0.82 ? pal.base : colors[Math.floor(rand() * colors.length)];
    body += `<circle cx="${f(rand() * W)}" cy="${f(rand() * W)}" r="${f(r)}" fill="${c}" fill-opacity="${f(0.55 + rand() * 0.45)}"/>`;
  }
  const big = poisson(rand, W, W, 14, (r) => 3.5 + r() * 8, 26);
  big.forEach((p, n) => {
    const ring = p.r > 6 && rand() < 0.6;
    const tilt = (rand() - 0.5) * 50;
    if (rand() < 0.4) {
      const a = rand() * Math.PI * 2;
      body += wrapped(p.x + Math.cos(a) * p.r * 2.6, p.y + Math.sin(a) * p.r * 2.6, 3, W, W, (x, y) => `<circle cx="${f(x)}" cy="${f(y)}" r="1.6" fill="${pal.base}" fill-opacity="0.8"/>`);
    }
    body += wrapped(p.x, p.y, p.r * 2.4, W, W, (x, y) =>
      `<g transform="rotate(${f(tilt)} ${f(x)} ${f(y)})">${ring ? `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(p.r * 2)}" ry="${f(p.r * 0.55)}" fill="none" stroke="${pal.base}" stroke-opacity="0.6" stroke-width="1"/>` : ""}<circle cx="${f(x)}" cy="${f(y)}" r="${f(p.r)}" fill="url(#pl${n % colors.length})"/>${ring ? `<path d="M${f(x - p.r * 2)} ${f(y)}A${f(p.r * 2)} ${f(p.r * 0.55)} 0 0 0 ${f(x + p.r * 2)} ${f(y)}" fill="none" stroke="${pal.base}" stroke-opacity="0.75" stroke-width="1"/>` : ""}</g>`);
  });
  for (const p of poisson(rand, W, W, 34, (r) => 3 + r() * 4.5, 16)) {
    const s = p.r;
    const c = rand() < 0.3 ? pal.accent : pal.base;
    body += wrapped(p.x, p.y, s, W, W, (x, y) =>
      `<path d="M${f(x)} ${f(y - s)}Q${f(x + s * 0.12)} ${f(y - s * 0.12)} ${f(x + s)} ${f(y)}Q${f(x + s * 0.12)} ${f(y + s * 0.12)} ${f(x)} ${f(y + s)}Q${f(x - s * 0.12)} ${f(y + s * 0.12)} ${f(x - s)} ${f(y)}Q${f(x - s * 0.12)} ${f(y - s * 0.12)} ${f(x)} ${f(y - s)}z" fill="${c}" fill-opacity="0.9"/>`);
  }
  return svg(W, W, body, defs);
}

// Embroidery: a cloth of fine cross stitches; eight-point stars, rosettes and a diamond lattice.
function stitch(pal, ground) {
  const C = 48;
  const S = 4;
  const W = C * S;
  const grid = new Map();
  const put = (x, y, c) => grid.set(`${(x + C) % C},${(y + C) % C}`, c);
  const tor = (a, b) => {
    const d = Math.abs(a - b);
    return Math.min(d, C - d);
  };
  for (let y = 0; y < C; y++) {
    for (let x = 0; x < C; x++) {
      for (const [cx, cy] of [
        [12, 12],
        [36, 36],
      ]) {
        const dx = tor(x, cx);
        const dy = tor(y, cy);
        const mx = Math.max(dx, dy);
        const mn = Math.min(dx, dy);
        if (dx + dy <= 1) put(x, y, "c");
        else if (dx + dy === 2) put(x, y, "b");
        else if (mn === 0 && mx >= 3 && mx <= 9) put(x, y, "a");
        else if (mn === 1 && mx >= 4 && mx <= 8) put(x, y, "a");
        else if (mn === 2 && mx >= 5 && mx <= 7) put(x, y, "a");
        else if (dx === dy && dx >= 2 && dx <= 6) put(x, y, "b");
        else if (Math.abs(dx - dy) === 1 && mx >= 3 && mx <= 5) put(x, y, "b");
        else if (dx + dy === 11 && mn >= 2 && mn % 2 === 0) put(x, y, "c");
      }
      for (const [cx, cy] of [
        [36, 12],
        [12, 36],
      ]) {
        const dx = tor(x, cx);
        const dy = tor(y, cy);
        const mx = Math.max(dx, dy);
        const mn = Math.min(dx, dy);
        if (dx + dy === 0) put(x, y, "b");
        else if (mn === 0 && mx <= 3) put(x, y, "a");
        else if (dx + dy === 4) put(x, y, "c");
        else if (dx === dy && dx === 3) put(x, y, "b");
        else if (dx + dy === 7 && mn >= 1) put(x, y, "b");
      }
      for (const [cx, cy] of [
        [0, 0],
        [24, 24],
        [24, 0],
        [0, 24],
      ]) {
        const dx = tor(x, cx);
        const dy = tor(y, cy);
        if (dx + dy === 0) put(x, y, "a");
        else if (dx + dy === 1) put(x, y, "c");
        else if (dx === 1 && dy === 1) put(x, y, "b");
      }
    }
  }
  // The lattice joining them, where nothing else is stitched.
  for (let y = 0; y < C; y++) {
    for (let x = 0; x < C; x++) {
      const k = `${x},${y}`;
      if (!grid.has(k) && ((x + y) % 24 === 0 || ((x - y) % 24 + 24) % 24 === 0)) grid.set(k, "b");
    }
  }
  const pathOf = (k) =>
    [...grid]
      .filter(([, c]) => c === k)
      .map(([key]) => {
        const [x, y] = key.split(",").map(Number);
        return `M${x * S + 0.6} ${y * S + 0.6}l2.8 2.8m0-2.8l-2.8 2.8`;
      })
      .join("");
  let weave = "";
  for (let y = 0; y < C; y += 2) for (let x = (y / 2) % 2; x < C; x += 2) if (!grid.has(`${x},${y}`)) weave += `M${x * S + 2} ${y * S + 2}h.01`;
  return svg(
    W,
    W,
    `<rect width="${W}" height="${W}" fill="${ground}"/>` +
      `<path d="${weave}" stroke="${pal.base}" stroke-opacity="0.28" stroke-width="1.1" stroke-linecap="round"/>` +
      `<path d="${pathOf("b")}" stroke="${pal.gold}" stroke-width="1.25" stroke-linecap="round"/>` +
      `<path d="${pathOf("a")}" stroke="${pal.red}" stroke-width="1.25" stroke-linecap="round"/>` +
      `<path d="${pathOf("c")}" stroke="${pal.teal}" stroke-width="1.25" stroke-linecap="round"/>`,
  );
}

// Aurora: blurred ribbons, and stars on the dark one; a picture with its ground.
function aurora(pal, ground, colors, stars) {
  const rand = rng(9);
  const W = 420;
  const H = 900;
  // One filter region over the whole picture: a region per ribbon cuts the blur off in bands.
  const defs = `<filter id="b" filterUnits="userSpaceOnUse" x="-200" y="-200" width="820" height="1300"><feGaussianBlur stdDeviation="26"/></filter><filter id="s" filterUnits="userSpaceOnUse" x="-200" y="-200" width="820" height="1300"><feGaussianBlur stdDeviation="8"/></filter>`;
  let body = `<rect width="${W}" height="${H}" fill="${ground}"/>`;
  const ribbons = [
    { d: "M-40 160 C 80 60, 160 260, 260 150 S 400 60, 470 180", w: 90, c: colors[0], o: 0.7 },
    { d: "M-40 300 C 90 220, 200 380, 300 260 S 420 230, 470 320", w: 70, c: colors[1], o: 0.55 },
    { d: "M-40 560 C 60 480, 220 640, 320 520 S 430 520, 470 600", w: 110, c: colors[2], o: 0.45 },
    { d: "M-40 780 C 100 720, 180 860, 300 760 S 420 740, 470 820", w: 80, c: colors[0], o: 0.35 },
  ];
  for (const r of ribbons) {
    body += `<path d="${r.d}" fill="none" stroke="${r.c}" stroke-opacity="${r.o}" stroke-width="${r.w}" stroke-linecap="round" filter="url(#b)"/>`;
    body += `<path d="${r.d}" fill="none" stroke="${r.c}" stroke-opacity="${f(r.o * 0.8)}" stroke-width="${f(r.w * 0.22)}" stroke-linecap="round" filter="url(#s)"/>`;
  }
  if (stars) {
    for (let i = 0; i < 220; i++) {
      const r = rand() < 0.9 ? 0.4 + rand() * 0.6 : 1 + rand() * 0.7;
      body += `<circle cx="${f(rand() * W)}" cy="${f(rand() * H)}" r="${f(r)}" fill="${pal.base}" fill-opacity="${f(0.35 + rand() * 0.6)}"/>`;
    }
  }
  return svg(W, H, body, defs);
}

const files = {};
for (const [id, draw] of Object.entries({ callsigns, network, topo, geometry, ether })) {
  files[`${id}-base.svg`] = draw(BASE);
  files[`${id}-accent.svg`] = draw(ACCENT);
}
files["space-dark.svg"] = space(PICTURE.dark);
files["space-light.svg"] = space(PICTURE.light);
files["stitch-dark.svg"] = stitch(PICTURE.dark, "#261f22");
files["stitch-light.svg"] = stitch(PICTURE.light, "#f6efe6");
files["aurora-dark.svg"] = aurora(PICTURE.dark, "#0e1424", ["#3ee0a8", "#7a6bff", "#ff6fa8"], true);
files["aurora-light.svg"] = aurora(PICTURE.light, "#f4f6fb", ["#7fe3c0", "#b3a8ff", "#ffb3cf"], false);
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(OUT, name), text);
  console.log(`${name}: ${(text.length / 1024).toFixed(1)} KB`);
}
