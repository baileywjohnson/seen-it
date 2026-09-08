import type { CluePayload } from "@shared";
import type { ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "plot" }>;

/** Five sentences, one per beat, each narrowing the field. Earlier ones stay on screen but fade back. */
export function PlotClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const n = payload.sentences.length;
  const shown = Math.min(n, Math.ceil((n * (clock.step + 1)) / 5));
  return (
    <div className="plot-stage">
      {payload.sentences.map((text, i) => {
        const visible = i < shown;
        const current = i === shown - 1;
        return (
          <div key={i} className={`plot-line ${visible ? "in" : ""} ${current ? "current" : ""}`}>
            <span className="plot-num">{i + 1}</span>
            <span className="plot-text">{visible ? text : "…"}</span>
          </div>
        );
      })}
    </div>
  );
}
