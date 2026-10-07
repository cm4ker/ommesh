/** Records the wallpaper drawing commands as static SVG; no drawing code ships to the client. */
export class Path2D {
  constructor(d) {
    this.d = d;
  }
}

const f = (value) => String(Math.round(value * 100) / 100);
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export class BackgroundSvg {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.parts = [];
    this.defs = [];
    this.stack = [];
    this.state = {
      fillStyle: "#000",
      strokeStyle: "#000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      transform: "",
      clips: [],
    };
    this.beginPath();
  }
  save() {
    this.stack.push({ ...this.state, clips: [...this.state.clips] });
  }
  restore() {
    if (!this.stack.length) throw new Error("Unbalanced wallpaper drawing state");
    this.state = this.stack.pop();
  }
  translate(x, y) {
    this.state.transform += `translate(${f(x)} ${f(y)}) `;
  }
  rotate(angle) {
    this.state.transform += `rotate(${f((angle * 180) / Math.PI)}) `;
  }
  scale(x, y) {
    this.state.transform += `scale(${f(x)} ${f(y)}) `;
  }
  beginPath() {
    this.d = "";
  }
  moveTo(x, y) {
    this.d += `M${f(x)} ${f(y)}`;
  }
  lineTo(x, y) {
    this.d += `L${f(x)} ${f(y)}`;
  }
  bezierCurveTo(a, b, c, d, e, g) {
    this.d += `C${[a, b, c, d, e, g].map(f).join(" ")}`;
  }
  closePath() {
    this.d += "Z";
  }
  arc(x, y, r, start, end) {
    if (end - start >= Math.PI * 2 && !this.d) {
      this.d = `M${f(x + r)} ${f(y)}a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0`;
      return;
    }
    this.ellipse(x, y, r, r, 0, start, end);
  }
  ellipse(x, y, rx, ry, rotation, start, end) {
    const point = (angle) => [
      x + rx * Math.cos(angle) * Math.cos(rotation) - ry * Math.sin(angle) * Math.sin(rotation),
      y + rx * Math.cos(angle) * Math.sin(rotation) + ry * Math.sin(angle) * Math.cos(rotation),
    ];
    const first = point(start);
    if (this.d) this.lineTo(...first);
    else this.moveTo(...first);
    const span = Math.min(Math.PI * 2, end - start);
    const segments = Math.ceil(span / Math.PI);
    for (let i = 1; i <= segments; i++) {
      const tip = point(start + (span * i) / segments);
      this.d += `A${f(rx)} ${f(ry)} ${f((rotation * 180) / Math.PI)} 0 1 ${tip.map(f).join(" ")}`;
    }
  }
  paint(d, fill) {
    if (!d) return;
    const s = this.state;
    const paint = fill
      ? `fill="${escape(s.fillStyle)}"`
      : `fill="none" stroke="${escape(s.strokeStyle)}" stroke-width="${f(s.lineWidth)}" stroke-linecap="${s.lineCap}" stroke-linejoin="${s.lineJoin}"`;
    const attributes = `${paint}${s.transform ? ` transform="${s.transform.trim()}"` : ""}`;
    const key = attributes + s.clips.join(",");
    const previous = this.parts.at(-1);
    if (previous?.key === key) {
      previous.d += d;
      return;
    }
    this.parts.push({ key, d, attributes, clips: [...s.clips] });
  }
  part({ d, attributes, clips }) {
    let part = `<path d="${d}" ${attributes}/>`;
    // Clips use world coordinates; an outer group keeps a shape's transform from applying twice.
    for (const clip of clips) part = `<g clip-path="url(#${clip})">${part}</g>`;
    return part;
  }
  stroke(path) {
    this.paint(path?.d ?? this.d, false);
  }
  fill() {
    this.paint(this.d, true);
  }
  clip() {
    const id = `c${this.defs.length}`;
    this.defs.push(`<clipPath id="${id}"><path d="${this.d}" transform="${this.state.transform.trim()}"/></clipPath>`);
    this.state.clips.push(id);
  }
  fillRect(x, y, width, height) {
    this.paint(`M${f(x)} ${f(y)}h${f(width)}v${f(height)}h${f(-width)}Z`, true);
  }
  strokeRect(x, y, width, height) {
    this.paint(`M${f(x)} ${f(y)}h${f(width)}v${f(height)}h${f(-width)}Z`, false);
  }
  background(color) {
    this.ground = color;
  }
  toSvg() {
    if (this.stack.length) throw new Error("Unbalanced wallpaper drawing state");
    // Motifs have their centres in one tile; neighbouring copies finish any shape crossing an edge.
    const copies = [];
    for (const y of [-this.height, 0, this.height]) for (const x of [-this.width, 0, this.width]) copies.push(`<use href="#art" x="${x}" y="${y}"/>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}"><defs>${this.defs.join("")}<g id="art">${this.parts.map((p) => this.part(p)).join("")}</g></defs><path fill="${this.ground}" d="M0 0h${this.width}v${this.height}H0Z"/>${copies.join("")}</svg>\n`;
  }
}

for (const key of ["fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin"]) {
  Object.defineProperty(BackgroundSvg.prototype, key, {
    get() {
      return this.state[key];
    },
    set(value) {
      this.state[key] = value;
    },
  });
}
