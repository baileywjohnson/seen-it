import { useEffect, useRef, useState } from "react";
import { clueLabel, type RoomState } from "@shared";
import { ClueStage } from "../clues";
import { Confetti } from "../components/Confetti";
import { Avatar } from "../components/Theatre";
import { Tickets } from "../components/Tickets";
import type { GameConnection } from "../ws";

export function Game({ conn, room, playerId }: { conn: GameConnection; room: RoomState; playerId: string }) {
  const me = room.players.find((p) => p.id === playerId)!;
  const clue = room.clue;
  const reveal = room.reveal;
  const roundIndex = (clue ?? reveal)?.roundIndex ?? 0;
  const rounds = (clue ?? reveal)?.rounds ?? room.settings.rounds;
  const win = conn.lastGuess?.correct ? conn.lastGuess : null;
  const [toast, setToast] = useState<{ at: number; points: number } | null>(null);
  useEffect(() => {
    if (!win) return;
    setToast({ at: win.at, points: win.points });
    const t = setTimeout(() => setToast(null), 1900);
    return () => clearTimeout(t);
  }, [win]);

  // The screen's height depends on both viewport axes (4:3, capped by width and height), so the
  // side panels follow its measured size instead of guessing in CSS.
  const gameRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const screen = screenRef.current;
    const game = gameRef.current;
    if (!screen || !game) return;
    const apply = () => game.style.setProperty("--screen-h", `${screen.getBoundingClientRect().height}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(screen);
    return () => ro.disconnect();
  }, []);

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <>
      <div className="topbar">
        <div className="now">
          <span aria-hidden="true">🎬</span> Feature {roundIndex + 1} of {rounds}
        </div>
        {clue ? (
          <div className="clue-pill" title={`Clue ${clue.clueIndex + 1} of ${clue.clueTotal}`}>
            <span>{clueLabel(clue.clueType, clue.payload)}</span>
            <span className="dots" aria-label={`Clue ${clue.clueIndex + 1} of ${clue.clueTotal}`}>
              {Array.from({ length: clue.clueTotal }, (_, i) => (
                <span key={i} className={`dot ${i < clue.clueIndex ? "done" : i === clue.clueIndex ? "now" : ""}`} />
              ))}
            </span>
          </div>
        ) : (
          <div className="clue-pill">🍿 Intermission</div>
        )}
        <div className="right">
          {me.guessedThisRound ? (
            <span className="status-pill won">✅ You got it! +{me.roundPoints}</span>
          ) : clue ? (
            <span className="status-pill">Type your guess below</span>
          ) : (
            <span className="status-pill">Next film soon</span>
          )}
        </div>
      </div>

      <div className="game" ref={gameRef}>
        <aside className="side-left" aria-label="Scoreboard">
          <Tickets players={room.players} meId={playerId} showScore />
        </aside>

        <main>
          <div className="screen" ref={screenRef}>
            {clue && <ClueStage key={`${clue.roundIndex}-${clue.clueIndex}`} clue={clue} serverOffset={conn.serverOffset} />}
            <div className="vignette" />
            <Confetti burst={win?.at ?? 0} />
            {toast && <div key={toast.at} className="guess-toast">🎉 +{toast.points}</div>}
            {reveal && (
              <div className="reveal">
                {reveal.posterUrl && <img src={reveal.posterUrl} alt="" />}
                <div className="info">
                  <div className="eyebrow">Feature {reveal.roundIndex + 1} was</div>
                  <h2>
                    {reveal.title} {reveal.year ? `(${reveal.year})` : ""}
                  </h2>
                  <div className="dir">
                    {reveal.director && <span>dir. {reveal.director}</span>}
                    {reveal.letterboxdUrl && (
                      <a href={reveal.letterboxdUrl} target="_blank" rel="noreferrer">Letterboxd ↗</a>
                    )}
                  </div>
                  <div className="results">
                    {[...reveal.results]
                      .sort((a, b) => b.points - a.points)
                      .map((r, i) => {
                        const p = room.players.find((x) => x.id === r.playerId);
                        if (!p) return null;
                        return (
                          <div key={r.playerId} className={r.points ? "" : "miss"} style={{ animationDelay: `${0.35 + i * 0.12}s` }}>
                            <span>
                              {r.points ? medals[i] ?? "✅" : "—"} {p.name}
                            </span>
                            <span className="pts">{r.points ? `+${r.points} · ${r.seconds}s` : "no guess"}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>

        <aside className="side-right">
          <Chat conn={conn} guessed={me.guessedThisRound} inClue={!!clue} />
        </aside>
      </div>
    </>
  );
}

function Chat({ conn, guessed, inClue }: { conn: GameConnection; guessed: boolean; inClue: boolean }) {
  const [text, setText] = useState("");
  const [shake, setShake] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [conn.chat.length]);

  useEffect(() => {
    if (conn.lastGuess && !conn.lastGuess.correct && conn.lastGuess.close) {
      setShake(true);
      const t = setTimeout(() => setShake(false), 400);
      return () => clearTimeout(t);
    }
  }, [conn.lastGuess]);

  // Keep the guess box focused when a new clue starts so nobody has to reach for the mouse.
  useEffect(() => {
    if (inClue) inputRef.current?.focus();
  }, [inClue]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    conn.send({ t: "guess", text: text.trim() });
    setText("");
  };

  return (
    <div className="card chatbox">
      <div className="chat-head">
        <span>{guessed ? "Winners' lounge" : "Guesses"}</span>
        <span className="sub">{guessed ? "winners only" : "everyone sees these"}</span>
      </div>
      <div className="chat-log" ref={logRef} aria-live="polite">
        {conn.chat.length === 0 && <div className="chat-empty">Guesses and chatter will show up here.</div>}
        {conn.chat.map((m) => (
          <div key={m.id} className={`m ${m.kind}`}>
            {m.from && (m.kind === "guess" || m.kind === "chat") && <Avatar name={m.from} small />}
            <span className="body">
              {m.from && (m.kind === "guess" || m.kind === "chat") && <b>{m.from}</b>}
              {m.kind === "close" && "🎯 "}
              {m.text}
            </span>
          </div>
        ))}
      </div>
      <form className="guess-form" onSubmit={submit}>
        <input
          ref={inputRef}
          className={`input ${guessed ? "correct" : ""} ${shake ? "shake" : ""}`}
          value={text}
          autoFocus
          maxLength={120}
          aria-label={guessed ? "Chat with the other winners" : "Your guess"}
          placeholder={guessed ? "Chat with winners…" : inClue ? "Guess the movie…" : "Chat…"}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn small" type="submit" aria-label="Send">➤</button>
      </form>
    </div>
  );
}
