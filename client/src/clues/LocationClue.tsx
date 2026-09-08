import { useRef } from "react";
import { geoGraticule10, geoMercator, geoPath, type GeoPermissibleObjects } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import world from "world-atlas/countries-110m.json";
import type { CluePayload } from "@shared";
import { fitCanvas, stepTransition, useRaf, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "location" }>;

const topo = world as unknown as Topology<{ countries: GeometryCollection }>;
const countries = feature(topo, topo.objects.countries) as unknown as GeoPermissibleObjects;
const graticule = geoGraticule10();

/** Zoom multipliers (relative to a world-fitting scale) and how far toward the target we centre. */
const ZOOM = [1, 3.2, 9, 30, 110];
const PULL = [0, 0.72, 0.94, 1, 1];

export function LocationClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target: [number, number] = [payload.lng, payload.lat];

  useRaf(clock, (elapsed) => {
    const canvas = ref.current;
    if (!canvas) return;
    const { ctx, W, H } = fitCanvas(canvas);
    const step = Math.min(ZOOM.length - 1, Math.floor(elapsed / clock.stepMs));
    const tr = stepTransition(clock, elapsed, step, 1500);
    const lerp = (a: number, b: number) => a + (b - a) * tr;
    const zoom = Math.exp(lerp(Math.log(ZOOM[Math.max(0, step - 1)]), Math.log(ZOOM[step])));
    const pull = lerp(PULL[Math.max(0, step - 1)], PULL[step]);
    const base = (W / (2 * Math.PI)) * 0.98;
    const center: [number, number] = [target[0] * pull, 18 + (target[1] - 18) * pull];
    const clampedLat = Math.max(-75, Math.min(75, center[1]));
    const projection = geoMercator().scale(base * zoom).center([center[0], clampedLat]).translate([W / 2, H / 2]);
    const path = geoPath(projection, ctx);

    // ocean + graticule
    ctx.fillStyle = "#bfe3f7";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(43, 26, 46, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    path(graticule);
    ctx.stroke();

    // land with a chunky cartoon outline (shadow pass + fill pass)
    ctx.lineJoin = "round";
    ctx.beginPath();
    path(countries);
    ctx.save();
    ctx.translate(3, 3);
    ctx.strokeStyle = "#2b1a2e";
    ctx.lineWidth = Math.min(10, 4 + zoom * 0.05);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#d8ecb3";
    ctx.fill();
    ctx.strokeStyle = "#2b1a2e";
    ctx.lineWidth = Math.min(6, 2.2 + zoom * 0.03);
    ctx.stroke();

    const pt = projection(target);
    if (!pt || step < 2) return;
    const [px, py] = pt;

    // radar ping
    const ping = (elapsed % 1600) / 1600;
    ctx.strokeStyle = `rgba(200, 50, 61, ${0.6 * (1 - ping)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, 8 + ping * 46, 0, Math.PI * 2);
    ctx.stroke();

    // bouncing pin with a soft shadow
    const bob = Math.abs(Math.sin(elapsed / 260)) * 8;
    ctx.fillStyle = "rgba(43,26,46,0.25)";
    ctx.beginPath();
    ctx.ellipse(px, py + 4, 14 - bob * 0.4, 6 - bob * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c8323d";
    ctx.strokeStyle = "#2b1a2e";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(px, py - bob);
    ctx.bezierCurveTo(px - 26, py - 34 - bob, px - 22, py - 60 - bob, px, py - 60 - bob);
    ctx.bezierCurveTo(px + 22, py - 60 - bob, px + 26, py - 34 - bob, px, py - bob);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fffaf0";
    ctx.beginPath();
    ctx.arc(px, py - 42 - bob, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const prefix = payload.kind === "set" ? "Set in " : "";
    const label = step >= 4 ? `${prefix}${payload.city}, ${payload.region}` : step >= 3 ? `${prefix}${payload.country}` : null;
    if (label && tr >= 1) {
      const pop = Math.min(1, (elapsed - step * clock.stepMs - 1500) / 300);
      ctx.font = "700 22px 'Lilita One', Impact, sans-serif";
      const w = ctx.measureText(label).width + 28;
      const lx = Math.max(10, Math.min(W - w - 10, px - w / 2));
      const ly = py - 105 - bob;
      ctx.save();
      ctx.translate(lx + w / 2, ly + 19);
      ctx.scale(0.6 + 0.4 * pop, 0.6 + 0.4 * pop);
      ctx.translate(-(lx + w / 2), -(ly + 19));
      ctx.fillStyle = "#f9c846";
      ctx.strokeStyle = "#2b1a2e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(lx, ly, w, 38, 10);
      else ctx.rect(lx, ly, w, 38);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2b1a2e";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + w / 2, ly + 20);
      ctx.restore();
    }
  });

  return <canvas ref={ref} />;
}
