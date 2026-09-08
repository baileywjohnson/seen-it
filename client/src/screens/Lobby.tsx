import { useEffect, useRef, useState } from "react";
import { SETTINGS_LIMITS, type Difficulty, type RoomSettings, type RoomState } from "@shared";
import { Marquee } from "../components/Theatre";
import { Tickets } from "../components/Tickets";
import { parseLetterboxdCsv } from "../csv";
import type { GameConnection } from "../ws";
import { storage } from "../storage";

const DIFFICULTIES: { key: Difficulty; label: string; desc: string }[] = [
  { key: "easy", label: "Cosy", desc: "Even the first clue helps" },
  { key: "normal", label: "Normal", desc: "Early clues are subtle" },
  { key: "hard", label: "Cinephile", desc: "Starts from the vaguest clue" },
];

const SETTING_META: { key: Exclude<keyof RoomSettings, "difficulty">; label: string; desc: string; unit: string }[] = [
  { key: "rounds", label: "Movies", desc: "How many films you'll guess", unit: "" },
  { key: "cluesPerMovie", label: "Clues per movie", desc: "From least to most revealing", unit: "" },
  { key: "clueSeconds", label: "Seconds per clue", desc: "Each clue unfolds in 5 beats", unit: "s" },
  { key: "revealSeconds", label: "Reveal time", desc: "Breather between films", unit: "s" },
];

export function Lobby({ conn, room, playerId }: { conn: GameConnection; room: RoomState; playerId: string }) {
  const me = room.players.find((p) => p.id === playerId)!;
  const isHost = room.hostId === playerId;
  const [copied, setCopied] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const readyPlayers = room.players.filter((p) => p.syncStatus === "ready").length;
  const pending = room.players.filter((p) => p.syncStatus !== "ready").map((p) => p.name);
  const canStart = room.poolCount > 0;
  const whyNot = readyPlayers === 0 ? "Upload at least one watchlist first." : "You have no films in common yet.";
  const shareUrl = `${location.origin}${location.pathname}?room=${room.code}`;

  const onCsv = async (file: File | undefined) => {
    if (!file) return;
    const films = parseLetterboxdCsv(await file.text());
    conn.send({ t: "setCsv", films });
    setShowExport(false);
  };

  useEffect(() => {
    if (!showExport) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShowExport(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showExport]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <Marquee title="THE LOBBY" sub="grab a seat, we start soon" />
      <div className="lobby">
        <div className="card">
          <h2>
            Tonight's Audience
            <span className="chip teal">{room.players.length} {room.players.length === 1 ? "seat" : "seats"}</span>
          </h2>
          <div className="room-row">
            <span className="lbl">Room</span>
            <span className="room-code" aria-label={`Room code ${room.code.split("").join(" ")}`}>{room.code}</span>
            <button className="btn small ghost" onClick={copy} aria-live="polite">{copied ? "✓ Copied" : "Copy invite link"}</button>
          </div>
          <Tickets players={room.players} meId={playerId} showScore={false} />

          <div className={`pool ${room.poolCount === 0 ? "empty" : ""}`}>
            <span style={{ fontSize: 36 }} aria-hidden="true">🍿</span>
            <div>
              <div className="big">{room.poolCount.toLocaleString()}</div>
              <div className="hint" style={{ margin: 0 }}>
                {room.poolCount === 0
                  ? "films in the pool so far"
                  : readyPlayers <= 1
                    ? "films to pick from"
                    : `films all ${readyPlayers} of you have seen`}
              </div>
            </div>
          </div>

          <label className="field">{me.syncStatus === "ready" ? "Your watched list" : "Add your watched list"}</label>
          <div className="upload-row">
            <button className="btn teal" onClick={() => fileRef.current?.click()}>
              📄 {me.syncStatus === "ready" ? "Replace watched.csv" : "Upload watched.csv"}
            </button>
            <button className="linkish" onClick={() => setShowExport(true)}>How do I get it?</button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => onCsv(e.target.files?.[0])} />
          </div>
          <p className="hint">From Letterboxd → Settings → Data → Export your data. The game only reads titles and years.</p>
        </div>

        <div className="card">
          <h2>
            Projection Booth
            {isHost ? <span className="chip">you're the host</span> : <span className="chip teal">host's controls</span>}
          </h2>
          <div className="settings">
            <div className="setting" style={{ gridTemplateColumns: "1fr" }}>
              <div>
                <div className="row2">
                  <span className="lbl">Difficulty</span>
                  <span className="desc">{DIFFICULTIES.find((d) => d.key === room.settings.difficulty)?.desc}</span>
                </div>
                <div className="segmented" style={{ marginTop: 4 }} role="radiogroup" aria-label="Difficulty">
                  {DIFFICULTIES.map((d) => (
                    <button
                      key={d.key}
                      role="radio"
                      aria-checked={room.settings.difficulty === d.key}
                      className={room.settings.difficulty === d.key ? "on" : ""}
                      disabled={!isHost}
                      onClick={() => conn.send({ t: "settings", settings: { difficulty: d.key } })}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {SETTING_META.map((s) => {
              const lim = SETTINGS_LIMITS[s.key];
              return (
                <div className="setting" key={s.key}>
                  <div>
                    <div className="row2">
                      <span className="lbl">{s.label}</span>
                      <span className="desc">{s.desc}</span>
                    </div>
                    <input
                      type="range"
                      min={lim.min}
                      max={lim.max}
                      value={room.settings[s.key]}
                      disabled={!isHost}
                      onChange={(e) => conn.send({ t: "settings", settings: { [s.key]: Number(e.target.value) } })}
                    />
                  </div>
                  <div className="val">
                    {room.settings[s.key]}
                    {s.unit}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="lobby-actions">
            {isHost ? (
              <>
                <button className="btn red big" disabled={!canStart} onClick={() => conn.send({ t: "start" })}>
                  🎬 Roll film
                </button>
                {!canStart && <span className="why">{whyNot}</span>}
              </>
            ) : (
              <div className="waiting">
                🎬 Waiting for the host to roll film<span className="dotdot" />
              </div>
            )}
            <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={conn.leave}>Leave</button>
          </div>
          {isHost && pending.length > 0 && canStart && (
            <p className="hint">
              {pending.length === 1 ? `${pending[0]} hasn't uploaded a watchlist yet.` : `${pending.length} players haven't uploaded a watchlist yet.`} You can start without them, but the film pool won't count their films.
            </p>
          )}
        </div>
      </div>

      {showExport && (
        <div className="modal-backdrop" onClick={() => setShowExport(false)}>
          <div className="card modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setShowExport(false)}>✕</button>
            <h2>Getting your watched.csv</h2>
            <p className="hint" style={{ marginTop: 0 }}>Takes about a minute, and works for private profiles too.</p>
            <ol className="steps">
              <li>
                Go to{" "}
                <a href="https://letterboxd.com/settings/data/" target="_blank" rel="noreferrer">
                  letterboxd.com/settings/data
                </a>{" "}
                and click <b>Export your data</b>.
              </li>
              <li>
                Unzip the download and find <b>watched.csv</b> (not diary.csv).
              </li>
              <li>Pick that file below. Nothing else in the export is read.</li>
            </ol>
            <button className="btn teal" onClick={() => fileRef.current?.click()}>📄 Choose watched.csv</button>
          </div>
        </div>
      )}
    </>
  );
}
