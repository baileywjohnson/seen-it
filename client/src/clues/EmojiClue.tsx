import type { CluePayload } from "@shared";
import { STEPS, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "emoji" }>;

export function EmojiClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const n = payload.emojis.length;
  const shown = Math.min(n, Math.ceil((n * (clock.step + 1)) / STEPS));
  return (
    <div className="emoji-stage">
      {payload.emojis.map((e, i) => {
        const visible = i < shown;
        return (
          <div key={i} className={`emoji-tile ${visible ? "in" : ""}`} style={{ ["--tilt" as string]: `${((i * 37) % 9) - 4}deg` }}>
            <span className="face front">?</span>
            <span className="face back">{e}</span>
          </div>
        );
      })}
    </div>
  );
}
