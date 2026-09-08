import type { CluePayload } from "@shared";
import type { ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "drawing" }>;

/**
 * Cartoon sketch drawn stroke by stroke. Each path gets its own CSS animation with a computed
 * delay, so the browser drives it at full frame rate with no React involvement.
 */
export function DrawingClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const n = payload.strokes.length;
  const drawTime = clock.duration * 0.92;
  const per = drawTime / n;
  const t0 = clock.elapsedAtMount;
  return (
    <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" style={{ background: "#fffaf0" }}>
      <defs>
        <filter id="wobble" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" />
        </filter>
      </defs>
      <g filter="url(#wobble)" strokeLinecap="round" strokeLinejoin="round">
        {payload.strokes.map((s, i) => {
          const hasFill = !!s.fill && s.fill !== "none";
          return (
            <path
              key={i}
              className="sketch-stroke"
              d={s.d}
              pathLength={1}
              stroke={s.stroke || "#2b1a2e"}
              strokeWidth={s.strokeWidth || 4}
              fill={hasFill ? s.fill : "none"}
              style={{
                animation: [
                  `sketchDraw ${per}ms linear ${i * per - t0}ms both`,
                  hasFill ? `sketchFill 320ms ease-out ${(i + 1) * per - t0}ms both` : "",
                ]
                  .filter(Boolean)
                  .join(", "),
              }}
            />
          );
        })}
      </g>
    </svg>
  );
}
