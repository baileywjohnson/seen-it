// Drawing vocabulary for Claude's sketches, and rendering for the self-review pass.
//
// Claude emits one element per string: "<shape> <numbers...> | <outline colour> | <outline width> | <fill or none>".
// Shapes: rect x y w h [rx] · ellipse cx cy rx ry · circle cx cy r · polygon x1,y1 x2,y2 ... · line x1 y1 x2 y2 · path <d>
// Everything is converted to SVG path data so the client renders (and animates) plain paths.

import { Resvg } from "@resvg/resvg-js";
import type { SceneStroke } from "../../../shared/src/index.js";

export const ELEMENT_FORMAT =
  'One element per string: "<shape> <numbers> | <outline colour> | <outline width> | <fill colour or none>". ' +
  "Shapes: rect x y w h [cornerRadius]; ellipse cx cy rx ry; circle cx cy r; polygon x1,y1 x2,y2 x3,y3 ...; line x1 y1 x2 y2; " +
  "path <SVG path data using M/L/C/Q/Z>. Canvas is 400 wide by 300 tall, origin top-left. " +
  'Examples: "rect 0 190 400 110 | #2b1a2e | 4 | #d8ecb3", "circle 200 120 38 | #2b1a2e | 4 | #f5cba7", "polygon 60,200 200,60 340,200 | #2b1a2e | 5 | #c8323d".';

const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\))$/i;
const PATH_RE = /^[MmLlCcQqZzHhVvSsTt0-9\s.,\-eE]+$/;
const KAPPA = 0.5522847498;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (s: string) => Number(s.replace(/,$/, ""));
const f = (n: number) => Math.round(n * 10) / 10;

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    `M ${f(cx + rx)} ${f(cy)}`,
    `C ${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}`,
    `C ${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)}`,
    `C ${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}`,
    `C ${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)} Z`,
  ].join(" ");
}

function rectPath(x: number, y: number, w: number, h: number, r: number): string {
  r = clamp(r, 0, Math.min(w, h) / 2);
  if (r <= 0) return `M ${f(x)} ${f(y)} L ${f(x + w)} ${f(y)} L ${f(x + w)} ${f(y + h)} L ${f(x)} ${f(y + h)} Z`;
  const k = r * KAPPA;
  return [
    `M ${f(x + r)} ${f(y)} L ${f(x + w - r)} ${f(y)}`,
    `C ${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)}`,
    `L ${f(x + w)} ${f(y + h - r)}`,
    `C ${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}`,
    `L ${f(x + r)} ${f(y + h)}`,
    `C ${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)}`,
    `L ${f(x)} ${f(y + r)}`,
    `C ${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)} Z`,
  ].join(" ");
}

/** Parse one element string into a path-based stroke; null if it's malformed. */
export function decodeElement(raw: string): SceneStroke | null {
  const parts = raw.split("|").map((x) => x.trim());
  const [shapeSpec = "", stroke = "", width = "", fill = ""] = parts;
  const tokens = shapeSpec.split(/\s+/).filter(Boolean);
  const kind = tokens[0]?.toLowerCase();
  const args = tokens.slice(1);
  let d: string | null = null;
  const nums = (n: number) => {
    const v = args.slice(0, n).map(num);
    return v.length === n && v.every(Number.isFinite) ? v : null;
  };
  switch (kind) {
    case "rect": {
      const v = nums(4);
      if (v) d = rectPath(v[0], v[1], v[2], v[3], args[4] ? num(args[4]) || 0 : 0);
      break;
    }
    case "ellipse": {
      const v = nums(4);
      if (v) d = ellipsePath(v[0], v[1], Math.abs(v[2]), Math.abs(v[3]));
      break;
    }
    case "circle": {
      const v = nums(3);
      if (v) d = ellipsePath(v[0], v[1], Math.abs(v[2]), Math.abs(v[2]));
      break;
    }
    case "polygon": {
      const pts = args.map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (pts.length >= 3) d = pts.map((p, i) => `${i ? "L" : "M"} ${f(p[0])} ${f(p[1])}`).join(" ") + " Z";
      break;
    }
    case "line": {
      const v = nums(4);
      if (v) d = `M ${f(v[0])} ${f(v[1])} L ${f(v[2])} ${f(v[3])}`;
      break;
    }
    case "path": {
      const data = args.join(" ");
      if (PATH_RE.test(data) && /[MmLlCcQq]/.test(data)) d = data;
      break;
    }
    default: {
      // Tolerate bare path data without the "path" keyword.
      if (PATH_RE.test(shapeSpec) && /^[Mm]/.test(shapeSpec)) d = shapeSpec;
    }
  }
  if (!d) return null;
  const isLine = kind === "line";
  return {
    d,
    stroke: COLOR_RE.test(stroke) ? stroke : "#2b1a2e",
    strokeWidth: clamp(Number(width) || 4, 1, 14),
    fill: !isLine && fill && fill.toLowerCase() !== "none" && COLOR_RE.test(fill) ? fill : "none",
  };
}

export function decodeElements(raw: string[]): SceneStroke[] {
  return raw.map(decodeElement).filter((x): x is SceneStroke => !!x).slice(0, 90);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function strokesToSvg(strokes: SceneStroke[]): string {
  const body = strokes
    .map((s) => `<path d="${esc(s.d)}" stroke="${esc(s.stroke)}" stroke-width="${s.strokeWidth}" fill="${esc(s.fill)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="800" height="600"><rect width="400" height="300" fill="#fffaf0"/>${body}</svg>`;
}

/** Render the drawing to a PNG (800x600) so Claude can look at its own work. */
export function renderPng(strokes: SceneStroke[]): Buffer {
  return Buffer.from(new Resvg(strokesToSvg(strokes), { fitTo: { mode: "width", value: 800 } }).render().asPng());
}
