/** The approved illustrated wallpapers, drawn once by `pnpm backgrounds`. */
import { BackgroundSvg, Path2D } from "./background-svg.mjs";
const W = 800,
  H = 1200,
  TAU = Math.PI * 2;
function doodle(c, type) {
  const p = (d) => {
    const path = new Path2D(d);
    c.stroke(path);
  };
  switch (type % 12) {
    case 0:
      p("M-15 20V-9Q-15-14-10-14H10Q15-14 15-9V20Q15 24 10 24H-10Q-15 24-15 20ZM-9-14V-35M-8-6H8V4H-8ZM-7 12H7M-7 17H2M19-26Q27-19 20-12M25-32Q38-19 27-6");
      break;
    case 1:
      p("M-37 19-10-25 14 19M-10-25-2-1 7-7M-3 19 21-18 43 19M-35 25H38");
      break;
    case 2:
      p("M-30 22 0-24 30 22ZM0-24 3 22M3 2 15 22M-36 22H35M-22-18l-5-4m13-5-2-7");
      break;
    case 3:
      circle(c, 0, 0, 24, c.strokeStyle);
      p("M-9 13 0-17 10 12 0 6ZM0 6V-17");
      circle(c, 0, 0, 29, c.strokeStyle);
      p("M0-35v6M35 0h-6M0 35v-6M-35 0h6");
      break;
    case 4:
      p("M0 29S-22 8-22-5a22 22 0 0 1 44 0C22 8 0 29 0 29Z");
      circle(c, 0, -5, 7, c.strokeStyle);
      break;
    case 5:
      p("M-24-3q10-15 25 0t26 0M-24 7q10-15 25 0t26 0M-24 17q10-15 25 0t26 0");
      break;
    case 6:
      p("M-24 10-10-19 3 10ZM-12 19 6-18 25 19ZM-10 10v15M6 19v12M-31 31H32");
      break;
    case 7:
      p("M-18 20 0-25 18 20M-9 5H9M-5-6H5M-23-16Q-34-4-24 7M23-16Q34-4 24 7M-30-24Q-49-4-31 15M30-24Q49-4 31 15");
      break;
    case 8:
      circle(c, 0, 0, 15, c.strokeStyle);
      c.save();
      c.rotate(-0.4);
      c.beginPath();
      c.ellipse(0, 0, 34, 8, 0, 0, TAU);
      c.stroke();
      c.restore();
      p("M24-29v8M20-25h8M-27 24v6M-30 27h6");
      break;
    case 9:
      p("M-18-8H13V18Q-2 28-18 18ZM13-3h6q14 9-6 15M-9-17q-7-6 0-12M3-17q-7-6 0-12M-23 28H22");
      break;
    case 10:
      p("M-28 10Q-7-20 18-7M18-7 8-9M18-7 15 3M-28 10q23 27 51 8M23 18l-9 2M23 18l-1-9");
      circle(c, -31, 7, 3, c.strokeStyle);
      break;
    case 11:
      p("M-26 11 16-18 24-5-18 24ZM-5-14l-8-12 17-12 8 12M5 12l8 12 17-12-8-12M-29 30l-6 5M-36 22l-9 3");
      break;
  }
}

function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.round(a * 100) / 100})`;
}
function line(c, points, color, width = 1) {
  c.beginPath();
  points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}
function circle(c, x, y, r, color, fill = false, width = 1) {
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.lineWidth = width;
  c[fill ? "fillStyle" : "strokeStyle"] = color;
  c[fill ? "fill" : "stroke"]();
}
function ground(c, color) {
  c.background(color);
}
function cross(c, x, y, size, color, width = 1) {
  line(
    c,
    [
      [x - size, y],
      [x + size, y],
    ],
    color,
    width,
  );
  line(
    c,
    [
      [x, y - size],
      [x, y + size],
    ],
    color,
    width,
  );
}
function grain(c, light, alpha = 0.025) {
  const r = random(182);
  c.fillStyle = rgba(light ? "#403327" : "#ebdfc7", alpha);
  c.beginPath();
  for (let i = 0; i < 240; i++) {
    const x = r() * W,
      y = r() * H;
    c.moveTo(x, y);
    c.lineTo(x + 0.7, y);
    c.lineTo(x + 0.7, y + 0.7);
    c.lineTo(x, y + 0.7);
    c.closePath();
  }
  c.fill();
}
function path(c, d) {
  c.stroke(new Path2D(d));
}
function star(c, x, y, r, color) {
  c.save();
  c.translate(x, y);
  c.fillStyle = color;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4,
      rr = i % 2 ? r * 0.23 : r;
    i ? c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : c.moveTo(rr, 0);
  }
  c.closePath();
  c.fill();
  c.restore();
}
function symbol(c, k) {
  if (k < 12) {
    doodle(c, k);
    return;
  }
  switch (k) {
    case 12:
      for (const rot of [0, Math.PI / 3, (Math.PI * 2) / 3]) {
        c.beginPath();
        c.ellipse(0, 0, 30, 11, rot, 0, TAU);
        c.stroke();
      }
      circle(c, 0, 0, 3, c.strokeStyle, true);
      break;
    case 13:
      path(c, "M-17-28H5M-13-28v23l-18 27q-3 6 3 6h51q5 0 2-6L1-5v-23M-19 9h32M-8-21H0M-8-12H0");
      circle(c, -4, 17, 2, c.strokeStyle);
      circle(c, 7, 22, 1.5, c.strokeStyle);
      break;
    case 14:
      path(c, "M-32-6 20-27 28-8-23 14ZM-29-1-36 2l5 12 8-3M21-21l8-4 4 9-7 3M-1 4v16M-2 13-17 35M-2 13l18 22M-17 35H17");
      break;
    case 15:
      path(c, "M-24-19Q-4-28 0-20q17-8 28 0v44q-19-10-28-2-14-9-28 0v-43ZM0-20v42M-20-11l13 2M-20-3l13 2M8-10l13-2M8-2l13-2M-19 6l11 2");
      break;
    case 16:
      path(c, "M-14 29H14M-6 29V13M6 29V13M-9 6H9M-12-2h24M-11-7q-19-22 1-27 25-7 26 13 0 11-12 18M-2-11v-12m0 0-5 6m5-6 6 5M-29-24l-6-4M28-28l7-4M29-12h8");
      break;
    case 17:
      path(c, "M-30 17-5-21 11-15 29-32M-20 26 6-12M3 1l8 10 21-9");
      for (const [x, y] of [
        [-30, 17],
        [-5, -21],
        [11, -15],
        [29, -32],
        [11, 11],
        [32, 2],
      ])
        circle(c, x, y, 4, c.strokeStyle);
      break;
    case 18:
      path(c, "M-16-28Q10-9-16 10T-16 37M16-28Q-10-9 16 10T16 37M-12-24H12M-6-16H6M-6-2H6M-12 6H12M-10 18H10M-5 26H5M-12 34H12");
      break;
    case 19:
      path(c, "M-19-20q19 8 38 0M-19-20q-3 29 19 46 23-18 19-46M-19-20q-2-11 19-11t19 11M-9-13q-4 12 0 23M0-11v27M9-13q4 12 0 23M-5 30H5");
      break;
    case 20:
      path(c, "M-25 19v-28q0-6 6-6h10l4-7H9l5 7h11q6 0 6 6v28q0 6-6 6h-44q-6 0-6-6Z");
      circle(c, 2, 4, 13, c.strokeStyle);
      circle(c, 2, 4, 8, c.strokeStyle);
      path(c, "M19-8h5M-18-8h6");
      break;
    case 21:
      path(c, "M-21 22h44V-10H-8v32M-8-10l15-17 16 17M-21 22V-2h13M-3-2h7v8h-7ZM13-2h6v8h-6ZM-2 22V13H9v9M-25 28H28M16-17v-14h5v22");
      break;
    case 22:
      path(c, "M-24 9q-14-13 0-22 7-17 24-8 24-5 21 15 15 3 10 16h-55M-18 20l-5 9M-3 20l-5 9M12 20l-5 9");
      break;
    case 23:
      path(c, "M-27 19Q0-32 27 19M-20 19Q0-16 20 19M-13 19Q0 0 13 19M-27 19h8M19 19h8");
      break;
    case 24:
      path(c, "M-16-26q16 7 32 0v38q-16 6-32 0ZM-16-26q-5-8 16-8t16 8M-16-8q16 7 32 0M-16 11l-9 17h50L16 11M-8 28v6M8 28v6");
      break;
    case 25:
      path(c, "M-27-12q15-20 27 0 14-20 27 0 10 18-27 40-39-23-27-40Z");
      break;
    case 26:
      path(c, "M-31 6h18L-6-21 14 31 19 6h15");
      circle(c, -31, 6, 3, c.strokeStyle);
      circle(c, 34, 6, 3, c.strokeStyle);
      break;
    case 27:
      path(c, "M-20-27 22-10 13 12-29-4ZM-8 5l-5 29M5 10l5 24M-22 34H18M24-14l8 4-10 21-7-4M-20-24l-8-3-5 15 8 3");
      break;
    case 28:
      circle(c, 0, 0, 27, c.strokeStyle);
      path(c, "M-26 0H26M0-27Q-26 0 0 27M0-27Q26 0 0 27M-21-16q21 9 42 0M-21 16q21-9 42 0");
      break;
    case 29:
      path(c, "M-24-22h48v38h-48ZM-18-16h36v24h-36ZM-17 25h34M-8 16v9M8 16v9M-10-6l7 7 14-12");
      break;
    case 30:
      path(c, "M-11 29V-5M11 29V-5M-23-5h46L0-34ZM-18 29h36M-5-22H5M-12-12h24M-3-5v34M-31 29h5M26 29h5");
      break;
    case 31:
      path(c, "M-25 14q11-22 20-6 12-35 24-13 14-7 19 12M-24 14q19 8 34 0t26 0M-17 25h38");
      break;
  }
}
function packed(c, seed, science, ink) {
  const rand = random(seed),
    occupied = [];
  c.lineCap = "round";
  c.lineJoin = "round";
  const collides = (x, y, r, gap) =>
    occupied.some((p) => Math.hypot(Math.min(Math.abs(x - p.x), W - Math.abs(x - p.x)), Math.min(Math.abs(y - p.y), H - Math.abs(y - p.y))) < r + p.r + gap);
  const add = (x, y, size, k) => {
    const r = size * 35;
    occupied.push({ x, y, r });
    c.save();
    c.translate(x, y);
    c.rotate((rand() - 0.5) * 1.25);
    c.scale(size, size);
    c.strokeStyle = ink(x, y);
    c.lineWidth = 2.5;
    symbol(c, k);
    c.restore();
  };
  for (let y = 30; y < H; y += H / 11)
    for (let x = 25; x < W; x += W / 8) {
      const xx = x + (rand() - 0.5) * 30,
        yy = y + (rand() - 0.5) * 25,
        size = 0.9 + rand() * 0.5;
      const k = science ? [8, 12, 13, 14, 15, 16, 17, 18, 24, 27, 28, 29][Math.floor(rand() * 12)] : Math.floor(rand() * 32);
      if (!collides(xx, yy, size * 35, 6)) add(xx, yy, size, k);
    }
  for (let i = 0; i < 5200; i++) {
    const x = rand() * W,
      y = rand() * H,
      s = 0.24 + rand() * 0.4,
      r = s * 35;
    if (collides(x, y, r, 4)) continue;
    add(x, y, s, science ? [8, 12, 13, 17, 18][Math.floor(rand() * 5)] : Math.floor(rand() * 32));
  }
  for (let i = 0; i < 10000; i++) {
    const x = rand() * W,
      y = rand() * H;
    if (collides(x, y, 4, 2)) continue;
    const col = ink(x, y);
    if (rand() > 0.65) cross(c, x, y, 3, col, 1.5);
    else if (rand() > 0.5) circle(c, x, y, 2.4, col, false, 1.4);
    else {
      circle(c, x, y, 1.3, col, true);
      circle(c, x + 5, y + 3, 1, col, true);
    }
    occupied.push({ x, y, r: 6 });
  }
}
function doodles(c, light) {
  ground(c, light ? "#edf3ed" : "#13191e");
  packed(c, 573, false, (x, y) => {
    const hue = 143 + 35 * (1 - Math.cos((x / W) * TAU)) + 66 * (1 - Math.cos((y / H) * TAU));
    return `hsla(${Math.round(hue)},${light ? "42%" : "49%"},${light ? "39%" : "54%"},${light ? 0.63 : 0.68})`;
  });
  grain(c, light);
}
function science(c, light) {
  ground(c, light ? "#b7dce0" : "#45838c");
  packed(c, 372, true, () => (light ? "#6a9fa6" : "#245661"));
  grain(c, light);
}
function expedition(c, light) {
  ground(c, light ? "#e6e2d9" : "#424448");
  packed(c, 671, false, () => (light ? "#8c8b82" : "#202226"));
  grain(c, light);
}
function planet(c, x, y, r, col, kind, rand) {
  c.save();
  c.translate(x, y);
  c.rotate((rand() - 0.5) * 0.8);
  if (kind === 1) {
    c.beginPath();
    c.ellipse(0, 0, r * 1.9, r * 0.48, -0.33, Math.PI, TAU);
    c.strokeStyle = "#dbd6ad";
    c.lineWidth = r * 0.19;
    c.stroke();
  }
  circle(c, 0, 0, r, col, true);
  c.save();
  c.beginPath();
  c.arc(0, 0, r, 0, TAU);
  c.clip();
  if (kind === 0 || kind === 1) {
    for (let j = -r; j < r; j += r * 0.37) {
      c.beginPath();
      c.moveTo(-r, j);
      c.bezierCurveTo(-r * 0.3, j + r * 0.24, r * 0.25, j - r * 0.19, r, j + r * 0.13);
      c.strokeStyle = j % 3 > 1 ? "#fff3b455" : "#432b452e";
      c.lineWidth = r * 0.14;
      c.stroke();
    }
  }
  if (kind === 2) {
    for (let i = 0; i < 8; i++) {
      const px = (rand() - 0.5) * r * 1.7,
        py = (rand() - 0.5) * r * 1.7,
        rr = r * (0.08 + rand() * 0.14);
      circle(c, px, py, rr, "#5e6e7e48", true);
      circle(c, px - rr * 0.2, py - rr * 0.2, rr * 0.66, "#edf3e155", true);
    }
  }
  if (kind === 3) {
    c.fillStyle = "#77ac83";
    for (let i = 0; i < 4; i++) {
      c.beginPath();
      const px = (rand() - 0.5) * r * 1.4,
        py = (rand() - 0.5) * r * 1.4;
      c.moveTo(px, py);
      for (let k = 0; k < 9; k++) {
        const a = (k * TAU) / 8;
        c.lineTo(px + Math.cos(a) * r * (0.16 + rand() * 0.4), py + Math.sin(a) * r * (0.15 + rand() * 0.4));
      }
      c.fill();
    }
  }
  c.beginPath();
  c.ellipse(r * 0.76, r * 0.2, r * 0.59, r * 1.4, 0.15, 0, TAU);
  c.fillStyle = "#1723331a";
  c.fill();
  c.restore();
  if (kind === 1) {
    c.beginPath();
    c.ellipse(0, 0, r * 1.9, r * 0.48, -0.33, 0, Math.PI);
    c.strokeStyle = "#e8ddb9";
    c.lineWidth = r * 0.17;
    c.stroke();
    c.beginPath();
    c.ellipse(0, 0, r * 2.05, r * 0.55, -0.33, 0, Math.PI);
    c.strokeStyle = "#a6b9c6";
    c.lineWidth = 1.1;
    c.stroke();
  }
  c.restore();
}
function planets(c, light) {
  ground(c, light ? "#e8edf3" : "#19273a");
  const rand = random(978),
    starInk = light ? "#66798c" : "#e0e9da";
  for (let i = 0; i < 1850; i++) {
    const x = rand() * W,
      y = rand() * H,
      band = Math.sin((x / W) * TAU * 1.4) * 125 + H * 0.47;
    const op = Math.abs(y - band) < 65 ? 0.4 : 0.14;
    circle(c, x, y, 0.4 + rand() * 0.5, rgba(starInk, op + rand() * 0.2), true);
  }
  const colors = ["#e2b44f", "#cb7c59", "#74ad98", "#d093a8", "#a8d9e2", "#c8d7c8"],
    placed = [];
  for (let attempt = 0; attempt < 5000 && placed.length < 43; attempt++) {
    const x = rand() * W,
      y = rand() * H,
      r = 11 + rand() * 12;
    if (placed.some((p) => Math.hypot(Math.min(Math.abs(p.x - x), W - Math.abs(p.x - x)), Math.min(Math.abs(p.y - y), H - Math.abs(p.y - y))) < p.r + r + 84))
      continue;
    placed.push({ x, y, r });
    const k = Math.floor(rand() * colors.length);
    planet(c, x, y, r, colors[k], k === 2 || k === 3 ? 1 : k === 4 ? 3 : k === 5 ? 2 : 0, rand);
  }
  for (let i = 0; i < 155; i++) {
    const x = rand() * W,
      y = rand() * H;
    if (i % 5 === 0) star(c, x, y, 4 + rand() * 4, rgba(starInk, 0.75));
    else if (i % 3 === 0) {
      cross(c, x, y, 2.5, rgba("#dab966", 0.78), 1.5);
    } else circle(c, x, y, 0.8, rgba(starInk, 0.8), true);
  }
  for (let i = 0; i < 10; i++) {
    const x = rand() * W,
      y = rand() * H;
    star(c, x, y, 4, rgba(starInk, 0.65));
    for (let j = 1; j < 14; j++) circle(c, x - j * 4, y + j * 2, 0.7, rgba(starInk, 0.6 - j * 0.035), true);
  }
  grain(c, light, 0.035);
}
function blocks(c, light) {
  ground(c, light ? "#e0dfd7" : "#161817");
  const rand = random(29),
    unit = 50,
    N = 16,
    M = 24,
    used = new Set();
  for (let y = 0; y < M; y++)
    for (let x = 0; x < N; x++) {
      if (used.has(x + "," + y)) continue;
      let ww = rand() > 0.55 ? 2 : 1,
        hh = rand() > 0.55 ? 2 : 1;
      if (rand() > 0.94) ww = 3;
      if (x + ww > N) ww = 1;
      if (y + hh > M) hh = 1;
      if (Array.from({ length: ww }, (_, i) => Array.from({ length: hh }, (_, j) => used.has(x + i + "," + (y + j))).some(Boolean)).some(Boolean)) {
        ww = hh = 1;
      }
      for (let a = 0; a < ww; a++) for (let b = 0; b < hh; b++) used.add(x + a + "," + (y + b));
      const px = x * unit + 3,
        py = y * unit + 3,
        w = ww * unit - 6,
        h = hh * unit - 6,
        hot = rand() < 0.2;
      c.fillStyle = light ? (rand() > 0.5 ? "#c8c8be" : "#d1d0c5") : rand() > 0.5 ? "#2c302e" : "#343735";
      c.fillRect(px, py, w, h);
      const diamond = ww === hh && rand() > 0.76;
      c.save();
      if (diamond) {
        c.translate(px + w / 2, py + h / 2);
        c.rotate(Math.PI / 4);
        c.scale(0.68, 0.68);
        c.translate(-px - w / 2, -py - h / 2);
      }
      for (let z = 4; z < Math.min(w, h) / 2 - 3; z += 8) {
        c.strokeStyle =
          hot && z === 12 ? (light ? "#cc6635" : "#d16632") : light ? (z % 16 === 4 ? "#aeb1a5" : "#e6e4d9") : z % 16 === 4 ? "#151a18" : "#535951";
        c.lineWidth = hot && z === 12 ? 4 : 3;
        c.strokeRect(px + z, py + z, w - z * 2, h - z * 2);
      }
      if (hot && Math.min(w, h) < 55) {
        c.strokeStyle = light ? "#c16031" : "#cc6030";
        c.lineWidth = 3;
        c.strokeRect(px + 8, py + 8, w - 16, h - 16);
      }
      c.restore();
    }
  grain(c, light, 0.035);
}
function leaf(c, x, y, angle, length, color, width = 0.3) {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(length * 0.35, -length * width, length * 0.81, -length * width, length, 0);
  c.bezierCurveTo(length * 0.58, length * width * 0.66, length * 0.3, length * width * 0.58, 0, 0);
  c.fill();
  c.restore();
}
function botanical(c, light) {
  const bg = light ? "#fbfcf5" : "#1c3438",
    ink = light ? "#b0d4d7" : "#72a2a2";
  ground(c, bg);
  const rand = random(172);
  for (let row = 0; row < 10; row++)
    for (let col = 0; col < 7; col++) {
      const x = col * (W / 7) + (row % 2) * (W / 14) + 22 + (rand() - 0.5) * 17,
        y = row * (H / 10) + 26 + (rand() - 0.5) * 16;
      const type = (row * 7 + col + 13) % 5;
      c.save();
      c.translate(x, y);
      c.rotate(rand() * TAU);
      c.strokeStyle = rgba(ink, 0.94);
      c.fillStyle = rgba(ink, 0.88);
      c.lineWidth = 2.2;
      if (type === 0) {
        path(c, "M0 48Q-18 0 8-52");
        for (let j = 0; j < 7; j++) {
          const yy = 33 - j * 12;
          leaf(c, -4, yy, -2.5 + (j % 2) * 0.2, 25 - j * 0.9, rgba(ink, 0.8));
          leaf(c, -4, yy, -0.68, 30 - j, rgba(ink, 0.88));
        }
      } else if (type === 1) {
        for (let j = 0; j < 8; j++) {
          c.save();
          c.rotate((j * TAU) / 8);
          leaf(c, 0, 3, -Math.PI / 2, 43, rgba(ink, 0.86), 0.21);
          c.restore();
        }
        circle(c, 0, 0, 5, bg, true);
        circle(c, 0, 0, 2, ink, true);
      } else if (type === 2) {
        path(c, "M-4 50C-60 9 46-55 28-10 6 27-19-20 3-19");
        leaf(c, -10, 23, -2.5, 37, ink);
        leaf(c, 10, -29, -0.7, 30, ink);
        leaf(c, 9, 41, -0.8, 29, ink);
      } else if (type === 3) {
        for (let j = 0; j < 5; j++) {
          c.save();
          c.rotate((j * TAU) / 5);
          c.beginPath();
          c.ellipse(0, -20, 11, 24, 0, 0, TAU);
          c.stroke();
          c.beginPath();
          c.ellipse(0, -19, 5, 16, 0, 0, TAU);
          c.stroke();
          c.restore();
        }
        circle(c, 0, 0, 7, bg, true);
        circle(c, 0, 0, 4, ink);
      } else {
        path(c, "M0 42Q22 0-4-41");
        for (let j = 0; j < 6; j++) {
          const yy = 24 - j * 11;
          leaf(c, 5, yy, -2.5, 24, ink, 0.18);
          leaf(c, 6, yy, -0.55, 25, ink, 0.18);
        }
        circle(c, -3, -43, 5, ink, true);
      }
      c.restore();
      const xx = x + 54,
        yy = y + 55;
      c.save();
      c.translate(xx, yy);
      c.rotate(rand() * TAU);
      c.strokeStyle = rgba(ink, 0.8);
      c.lineWidth = 1.7;
      if ((col + row) % 2) {
        path(c, "M-18 16C-35-5 4-29 13-12 21 6-4 16-5 3-5-6 7-5 5 1");
        leaf(c, -18, 15, -0.55, 20, rgba(ink, 0.8), 0.23);
      } else {
        path(c, "M-4 19Q-10 0 5-20");
        for (let i = 0; i < 4; i++) {
          leaf(c, -2, 10 - i * 7, -2.6, 13, ink, 0.23);
          leaf(c, -2, 10 - i * 7, -0.6, 14, ink, 0.23);
        }
      }
      c.restore();
      circle(c, xx + 21, yy + 30, 2.2, rgba(ink, 0.85), true);
    }
  grain(c, light, 0.015);
}
function damask(c, light) {
  const bg = light ? "#eee2c9" : "#201d20",
    red = light ? "#a84949" : "#9e343c",
    gold = light ? "#a28b55" : "#bdac7f";
  ground(c, bg);
  function motif(x, y, color) {
    c.save();
    c.translate(x, y);
    c.scale(1.15, 1.15);
    c.strokeStyle = color;
    c.lineWidth = 2.2;
    c.lineCap = "round";
    for (const mirror of [-1, 1]) {
      c.save();
      c.scale(mirror, 1);
      path(c, "M0 93C14 48 71 55 74 7 78-40 10-48 17-8 20 14 48 2 40-10M0 94C-4 61 30 7 1-33M0 44C-5 4 6-38 0-87");
      for (let j = 0; j < 8; j++) {
        const y0 = 72 - j * 11,
          x0 = 12 + Math.sin((j / 7) * Math.PI) * 38;
        leaf(c, x0, y0, -0.57 - j * 0.08, 43 - j * 1.2, color, 0.28);
        leaf(c, x0 - 2, y0 + 2, -2.65 - j * 0.04, 27, color, 0.21);
      }
      leaf(c, 0, -29, -0.83, 48, color, 0.23);
      leaf(c, 1, -50, -1.05, 37, color, 0.24);
      leaf(c, 0, -70, -1.39, 38, color, 0.24);
      path(c, "M0-92C30-115 68-77 51-65M3 96C21 99 29 116 0 134M65 41C119 20 107-39 88-16 68 8 106 17 101-4");
      leaf(c, 40, -83, -0.5, 23, color, 0.27);
      for (let j = 0; j < 5; j++) {
        leaf(c, 80 + j * 2, 29 - j * 11, -0.4 - j * 0.3, 27, color, 0.22);
      }
      for (let j = 0; j < 5; j++) leaf(c, 26 + j * 7, -36 + j * 5, -0.7, 26 - j, color, 0.23);
      c.restore();
    }
    circle(c, 0, -2, 6, color, true);
    circle(c, 0, 145, 4, color, true);
    c.restore();
  }
  for (let row = 0; row < 6; row++)
    for (let col = 0; col < 3; col++) {
      const x = col * (W / 3) + (row % 2) * (W / 6),
        y = row * (H / 6) + 40;
      motif(x, y, (row + col) % 3 === 0 ? gold : red);
    }
  grain(c, light, 0.06);
}
function confetti(c, light) {
  ground(c, light ? "#f1e8d5" : "#417f90");
  const rand = random(862),
    cols = light ? ["#ae493a", "#759386", "#537c91", "#cfb887"] : ["#efe7dd", "#e3bbad", "#ce342e", "#3b5e36"];
  for (let row = 0; row < 10; row++)
    for (let col = 0; col < 7; col++) {
      const x = col * (W / 7) + (row % 2) * (W / 14) + 15 + (rand() - 0.5) * 24,
        y = row * (H / 10) + 20 + (rand() - 0.5) * 30;
      circle(c, x, y, 3.8 + rand() * 2, cols[Math.floor(rand() * cols.length)], true);
    }
  grain(c, light, 0.018);
}

export const BACKGROUND_ART = {
  doodles,
  planets,
  botanical,
  science,
  blocks,
  expedition,
  damask,
  confetti,
};
export function drawBackground(id, light) {
  const canvas = new BackgroundSvg(W, H);
  BACKGROUND_ART[id](canvas, light);
  return canvas.toSvg();
}
