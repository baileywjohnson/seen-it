import { useRef } from "react";
import { hashString, type CluePayload } from "@shared";
import { fitCanvas, stepTransition, useRaf, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "year" }>;

const WINDOWS = [140, 60, 30, 12, 4];

/** Keyframe windows [start, end] that shrink onto the release year. */
function windows(year: number): [number, number][] {
  const seed = hashString(String(year));
  const out: [number, number][] = [[1888, 2028]];
  for (let i = 1; i < WINDOWS.length; i++) {
    const w = WINDOWS[i];
    // Put the year somewhere inside the window (never centred, so the middle isn't a tell).
    const frac = 0.2 + (((seed >> (i * 5)) & 31) / 31) * 0.6;
    let start = Math.round(year - w * frac);
    start = Math.max(1888, Math.min(2028 - w, start));
    out.push([start, start + w]);
  }
  return out;
}

function tickEvery(span: number): number {
  if (span > 100) return 20;
  if (span > 45) return 10;
  if (span > 20) return 5;
  if (span > 8) return 2;
  return 1;
}

export function YearClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const keys = useRef(windows(payload.year)).current;

  useRaf(clock, (elapsed) => {
    const canvas = ref.current;
    if (!canvas) return;
    const { ctx, W, H } = fitCanvas(canvas);
    const step = Math.min(keys.length - 1, Math.floor(elapsed / clock.stepMs));
    const tr = stepTransition(clock, elapsed, step, 1100);
    const from = keys[Math.max(0, step - 1)];
    const to = keys[step];
    const start = from[0] + (to[0] - from[0]) * tr;
    const end = from[1] + (to[1] - from[1]) * tr;
    const span = end - start;
    const pad = 40;
    const x = (y: number) => pad + ((y - start) / span) * (W - pad * 2);
    const midY = H * 0.55;

    ctx.fillStyle = "#fffaf0";
    ctx.fillRect(0, 0, W, H);

    // film strip
    ctx.fillStyle = "#2b1a2e";
    ctx.fillRect(0, midY - 44, W, 88);
    ctx.fillStyle = "#fffaf0";
    const sprocketShift = ((elapsed / 40) % 22); // strip creeps along as time passes
    for (let px = -22 + sprocketShift; px < W; px += 22) {
      ctx.fillRect(px, midY - 38, 12, 10);
      ctx.fillRect(px, midY + 28, 12, 10);
    }
    ctx.fillStyle = "#f6e3b8";
    ctx.fillRect(0, midY - 20, W, 40);

    // ticks
    const every = tickEvery(span);
    ctx.font = "900 18px Nunito, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let y = Math.ceil(start / every) * every; y <= end; y += every) {
      const px = x(y);
      if (px < pad - 2 || px > W - pad + 2) continue;
      ctx.strokeStyle = "#2b1a2e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px, midY - 20);
      ctx.lineTo(px, midY + 20);
      ctx.stroke();
      ctx.fillStyle = "#2b1a2e";
      ctx.fillText(String(y), px, midY + 74);
    }
    if (every > 1) {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let y = Math.ceil(start); y <= end; y++) {
        if (y % every === 0) continue;
        const px = x(y);
        ctx.moveTo(px, midY - 9);
        ctx.lineTo(px, midY + 9);
      }
      ctx.stroke();
    }

    // next zoom window (a "magnifier" band) shown once the transition settles
    if (step < keys.length - 1 && tr >= 1) {
      const nxt = keys[step + 1];
      const x0 = x(nxt[0]);
      const x1 = x(nxt[1]);
      const pulse = 0.5 + 0.5 * Math.sin(elapsed / 180);
      ctx.fillStyle = `rgba(200, 50, 61, ${0.12 + pulse * 0.12})`;
      ctx.fillRect(x0, midY - 52, x1 - x0, 104);
      ctx.strokeStyle = "#c8323d";
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -elapsed / 30;
      ctx.strokeRect(x0, midY - 52, x1 - x0, 104);
      ctx.setLineDash([]);
    }

    // final marker
    if (step === keys.length - 1 && tr >= 1) {
      const px = x(payload.year);
      const bob = Math.sin(elapsed / 220) * 5;
      ctx.fillStyle = "#f9c846";
      ctx.strokeStyle = "#2b1a2e";
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(px, midY - 50);
      ctx.lineTo(px - 18, midY - 90 + bob);
      ctx.lineTo(px + 18, midY - 90 + bob);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.font = "700 44px 'Lilita One', Impact, sans-serif";
      ctx.fillStyle = "#c8323d";
      ctx.lineWidth = 6;
      ctx.strokeText(String(payload.year), px, midY - 105 + bob);
      ctx.fillText(String(payload.year), px, midY - 105 + bob);
    }
  });

  return <canvas ref={ref} />;
}
