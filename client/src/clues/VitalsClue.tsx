import type { CluePayload } from "@shared";
import { STEPS, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "vitals" }>;

/** Plain facts about the film, one card per beat. */
export function VitalsClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const n = payload.facts.length;
  const shown = Math.min(n, Math.ceil((n * (clock.step + 1)) / STEPS));
  return (
    <div className="vitals-stage">
      {payload.facts.map((f, i) => (
        <div key={f.label} className={`vital ${i < shown ? "in" : ""}`} style={{ ["--tilt" as string]: `${i % 2 ? 1 : -1}deg` }}>
          <div className="vital-label">{f.label}</div>
          <div className="vital-value">{i < shown ? f.value : "?"}</div>
        </div>
      ))}
    </div>
  );
}
