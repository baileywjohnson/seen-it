import { useEffect, useState } from "react";
import { Marquee } from "../components/Theatre";
import { storage } from "../storage";
import { NAME_KEY, type GameConnection } from "../ws";

export function Home({ conn }: { conn: GameConnection }) {
  const params = new URLSearchParams(location.search);
  const [name, setName] = useState(() => storage.get(NAME_KEY) ?? "");
  const [code, setCode] = useState(() => (params.get("room") ?? "").toUpperCase());
  const [busy, setBusy] = useState(false);
  const [crash, setCrash] = useState<string | null>(null);
  const invited = code.length === 4;

  useEffect(() => {
    if (conn.error) setBusy(false);
  }, [conn.error]);
  useEffect(() => {
    const onErr = (e: ErrorEvent) => setCrash(e.message);
    const onRej = (e: PromiseRejectionEvent) => setCrash(String(e.reason));
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  const go = (join: boolean) => {
    if (!name.trim()) return;
    storage.set(NAME_KEY, name.trim());
    setBusy(true);
    conn.join({ code: join ? code.trim().toUpperCase() : null, name: name.trim() });
  };

  return (
    <div className="home">
      <Marquee title="SEEN IT!" sub="a movie guessing game" icon="🍿" />
      <div className="card">
        <label className="field" htmlFor="name">Your name</label>
        <input
          id="name"
          className="input"
          value={name}
          maxLength={20}
          placeholder="Roger E."
          autoComplete="nickname"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && go(invited)}
        />
        <div className="home-actions">
          {invited ? (
            <>
              <button className="btn red big" disabled={!name.trim() || busy} onClick={() => go(true)}>
                🎟️ Join theatre {code}
              </button>
              <div className="or">or</div>
              <button className="btn ghost small" disabled={!name.trim() || busy} onClick={() => go(false)}>
                Open a new theatre instead
              </button>
            </>
          ) : (
            <>
              <button className="btn red big" disabled={!name.trim() || busy} onClick={() => go(false)}>
                🎬 Open a new theatre
              </button>
              <div className="or">or join a friend</div>
              <div className="row">
                <input
                  className="input code-input"
                  value={code}
                  maxLength={4}
                  placeholder="CODE"
                  aria-label="Room code"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && code.length === 4 && go(true)}
                />
                <button className="btn teal" disabled={!name.trim() || code.length !== 4 || busy} onClick={() => go(true)}>
                  Join
                </button>
              </div>
            </>
          )}
        </div>
        {conn.error && <div className="error">{conn.error}</div>}
        {crash && !conn.error && <div className="error">Something broke in the browser: {crash}</div>}
        {busy && !conn.error && conn.connectionProblem && <div className="error">{conn.connectionProblem}</div>}
        {busy && !conn.error && !conn.connectionProblem && <p className="hint">Finding your seat…</p>}
      </div>
      <div className="how">
        <div><span>📄</span>Everyone uploads their Letterboxd watched list in the lobby.</div>
        <div><span>🎬</span>Clues about a film you've all seen get bolder every few seconds.</div>
        <div><span>🏆</span>Guess fast, and before your friends, to score the most.</div>
      </div>
      <p className="footer-note">Clues are written by Claude · film data from Letterboxd</p>
    </div>
  );
}
