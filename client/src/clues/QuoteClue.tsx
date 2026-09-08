import type { CluePayload } from "@shared";
import { STEPS, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "quote" }>;

export function QuoteClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const words = payload.text.split(/\s+/);
  const n = words.length;
  const revealCount = Math.min(n, Math.ceil((n * (clock.step + 1)) / STEPS));
  const revealed = new Set(payload.order.slice(0, revealCount));
  return (
    <div className="quote-stage">
      <div className="quote-mark">“</div>
      <p>
        {words.map((w, i) => (
          <span key={i} className={`word ${revealed.has(i) ? "shown" : ""}`}>
            <span className="redact" style={{ width: `${Math.max(1.2, w.replace(/[^\w']/g, "").length * 0.62)}em` }} />
            <span className="text">{w}</span>
          </span>
        ))}
      </p>
      <div className="quote-mark">”</div>
    </div>
  );
}
