import { useEffect, useRef, useState } from "react";
import type { RoomState } from "@shared";

const TIPS = [
  "Guesses are forgiving: a <b>typo or a missing “The”</b> still counts.",
  "The first clue barely helps. The <b>last one practically says the title</b>.",
  "Points drop as the clues get easier, and <b>beating your friends</b> to it earns a bonus.",
  "<b>Wrong guesses show up in chat</b> for everyone, so guess carefully.",
  "Once you've guessed, the chat only reaches the <b>other winners</b>.",
  "The next films generate while you play, so only the first one makes you wait.",
];

export function Loading({ room }: { room: RoomState }) {
  const progress = room.loading?.progress ?? 0.02;
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.floor((now - startedAt.current) / 1000);
  const [head, stage] = (room.loading?.message ?? "Rolling the projector…").split("… ");
  const tip = TIPS[Math.floor(seconds / 6) % TIPS.length];
  return (
    <div className="loading">
      <div className="reel" aria-hidden="true">🎞️</div>
      <h2>{head}…</h2>
      <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} />
      </div>
      <div className="meta">
        <span>{stage ?? "Warming up"}</span>
        <span>
          {Math.round(progress * 100)}% · {seconds}s
        </span>
      </div>
      <div className="tip" key={tip} dangerouslySetInnerHTML={{ __html: `💡 ${tip}` }} />
    </div>
  );
}
