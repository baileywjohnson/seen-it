import type { CluePayload } from "@shared";
import { STEPS, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "blanks" }>;
/** Share of letters shown at each beat. */
const REVEAL = [0.25, 0.4, 0.55, 0.7, 0.85];

/** The title as letter tiles; letters fill in over the beats, punctuation is always shown. */
export function BlanksClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const words = payload.title.split(/\s+/);
  const letters = payload.title.replace(/[^\p{L}\p{N}]/gu, "").length;
  const revealCount = Math.round(letters * REVEAL[Math.min(STEPS - 1, clock.step)]);
  const revealed = new Set(payload.order.slice(0, revealCount));
  let li = -1;
  return (
    <div className="blanks-stage">
      {words.map((w, wi) => (
        <div key={wi} className="blanks-word">
          {w.split("").map((ch, ci) => {
            const isLetter = /[\p{L}\p{N}]/u.test(ch);
            if (!isLetter) return <span key={ci} className="blank punct">{ch}</span>;
            li++;
            const show = revealed.has(li);
            return (
              <span key={ci} className={`blank ${show ? "shown" : ""}`}>
                <span className="glyph">{show ? ch.toUpperCase() : ""}</span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
