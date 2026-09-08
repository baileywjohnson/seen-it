import type { CluePayload } from "@shared";
import { STEPS, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "anagram" }>;
/** Share of letters snapped into their true place at each beat. */
const SETTLE = [0, 0.2, 0.4, 0.6, 0.8];

/** The title's letters scrambled within each word; some settle into place as the beats pass. */
export function AnagramClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const total = payload.solution.join("").replace(/[^\p{L}\p{N}]/gu, "").length;
  const settled = new Set(payload.order.slice(0, Math.round(total * SETTLE[Math.min(STEPS - 1, clock.step)])));
  let li = -1;
  return (
    <div className="blanks-stage anagram">
      <div className="eyebrow">Unscramble the title</div>
      {payload.words.map((scrambled, wi) => {
        const truth = payload.solution[wi] ?? "";
        return (
          <div key={wi} className="blanks-word">
            {scrambled.split("").map((ch, ci) => {
              const isLetter = /[\p{L}\p{N}]/u.test(ch);
              if (!isLetter) return <span key={ci} className="blank punct">{ch}</span>;
              li++;
              const fixed = settled.has(li);
              return (
                <span key={ci} className={`blank ${fixed ? "shown fixed" : "loose"}`}>
                  <span className="glyph">{fixed ? truth[ci] : ch}</span>
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
