import type { CluePayload } from "@shared";
import type { ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "list" }>;

/** Names revealed one per beat: cast (least famous first), characters (side roles first), a director's other films. */
export function ListClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const n = payload.items.length;
  const shown = Math.min(n, Math.ceil((n * (clock.step + 1)) / 5));
  return (
    <div className="cast-stage">
      <div className="eyebrow">{payload.heading}</div>
      {payload.items.map((item, i) => {
        const visible = i < shown;
        const last = i === n - 1;
        return (
          <div
            key={item}
            className={`cast-card ${visible ? "in" : ""} ${last ? "lead" : ""}`}
            style={{ fontSize: Math.min(34, 20 + i * 3), ["--tilt" as string]: `${i % 2 ? 1 : -1}deg` }}
          >
            {visible ? item : "…"}
          </div>
        );
      })}
    </div>
  );
}
