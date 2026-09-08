import { useLayoutEffect, useRef } from "react";
import type { PublicPlayer } from "@shared";
import { Avatar } from "./Theatre";

/** Player list as ticket stubs. In-game it's sorted by score and rows glide to their new spot. */
export function Tickets({ players, meId, showScore }: { players: PublicPlayer[]; meId: string; showScore: boolean }) {
  const sorted = showScore ? [...players].sort((a, b) => b.score - a.score) : players;
  const rows = useRef(new Map<string, HTMLDivElement>());
  const lastTop = useRef(new Map<string, number>());

  // FLIP: when the order changes, start each row where it used to be and let it slide into place.
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const [id, el] of rows.current) {
      const top = el.getBoundingClientRect().top;
      const prev = lastTop.current.get(id);
      if (prev !== undefined && Math.abs(prev - top) > 1) {
        el.style.transition = "none";
        el.style.transform = `translateY(${prev - top}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 0.45s cubic-bezier(0.2, 1.2, 0.4, 1)";
          el.style.transform = "";
        });
      }
      next.set(id, top);
    }
    lastTop.current = next;
  });

  return (
    <div className={`tickets ${showScore ? "compact" : ""}`}>
      {sorted.map((p, i) => (
        <div
          key={p.id}
          ref={(el) => (el ? rows.current.set(p.id, el) : rows.current.delete(p.id))}
          className={`ticket ${p.id === meId ? "me" : ""} ${p.guessedThisRound ? "guessed" : ""} ${p.connected ? "" : "offline"}`}
        >
          <div className="ticket-body">
            <div className={`rank ${showScore && i === 0 && p.score > 0 ? "gold" : ""}`}>{showScore ? `#${i + 1}` : `${String.fromCharCode(65 + Math.floor(i / 6))}${(i % 6) + 1}`}</div>
            <Avatar name={p.name} />
            <div style={{ minWidth: 0 }}>
              <div className="name">
                <span className="label">{p.name}</span>
                {showScore ? null : (
                  <>
                    {p.id === meId && <span className="chip teal">you</span>}
                    {p.isHost && <span className="chip" title="Host">host</span>}
                  </>
                )}
              </div>
              {showScore ? (
                <div className="meta">{p.connected ? (p.guessedThisRound ? "got it" : p.id === meId ? "you" : "guessing…") : "reconnecting…"}</div>
              ) : (
                <div className={`sync ${p.syncStatus}`}>
                  {p.syncStatus === "none" && "hasn't uploaded yet"}
                  {p.syncStatus === "syncing" && `⏳ ${p.syncMessage}`}
                  {p.syncStatus === "ready" && `🍿 ${p.filmCount.toLocaleString()} films`}
                  {p.syncStatus === "error" && `⚠️ ${p.syncMessage}`}
                </div>
              )}
            </div>
            {showScore && (
              <div className="score">
                {p.score}
                {p.roundPoints > 0 && <span className="plus">+{p.roundPoints}</span>}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
