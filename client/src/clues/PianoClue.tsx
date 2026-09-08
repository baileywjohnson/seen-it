import { useEffect, useMemo, useRef, useState } from "react";
import type { CluePayload, PianoNote } from "@shared";
import { useRaf, type ClueClock } from "./clock";

type P = Extract<CluePayload, { type: "piano" }>;

const SEMIS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function toMidi(note: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(\d)$/.exec(note);
  if (!m) return null;
  let s = SEMIS[m[1].toUpperCase()];
  if (m[2] === "#") s++;
  if (m[2] === "b") s--;
  return 12 * (Number(m[3]) + 1) + s;
}

interface Event {
  midi: number | null;
  at: number; // ms from melody start
  dur: number; // ms
}

function schedule(notes: PianoNote[], tempo: number): { events: Event[]; total: number } {
  const beat = 60000 / tempo;
  let t = 0;
  const events: Event[] = [];
  for (const n of notes) {
    const dur = n.beats * beat;
    events.push({ midi: n.note === "R" ? null : toMidi(n.note), at: t, dur });
    t += dur;
  }
  return { events, total: t };
}

let audioCtx: AudioContext | null = null;
function getAudio(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(ctx: AudioContext, midi: number, when: number, dur: number): void {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = Math.min(6000, freq * 6);
  gain.connect(filter).connect(ctx.destination);
  const seconds = Math.max(0.12, dur / 1000);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(0.22, when + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.06, when + Math.min(seconds * 0.6, 0.5));
  gain.gain.exponentialRampToValueAtTime(0.0008, when + seconds + 0.25);
  for (const [type, mult, vol] of [["triangle", 1, 1], ["sine", 2, 0.35], ["sine", 3, 0.12]] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq * mult;
    const g = ctx.createGain();
    g.gain.value = vol;
    osc.connect(g).connect(gain);
    osc.start(when);
    osc.stop(when + seconds + 0.3);
  }
}

const LOOP_GAP = 1200;

export function PianoClue({ payload, clock }: { payload: P; clock: ClueClock }) {
  const { events, total } = useMemo(() => schedule(payload.notes, payload.tempo), [payload]);
  const loopLen = total + LOOP_GAP;
  const [enabled, setEnabled] = useState(() => !!audioCtx && audioCtx.state === "running");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [heard, setHeard] = useState(0);
  const scheduledUpTo = useRef(-1);
  const anchorRef = useRef<number | null>(null); // audio-context time corresponding to elapsed = 0
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const lastVis = useRef({ idx: -2, count: -1 });

  useRaf(clock, (elapsed) => {
    // Visuals: only touch React state when the highlighted note actually changes.
    const pos = elapsed % loopLen;
    let idx = -1;
    let count = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.at <= pos) count++;
      if (pos >= e.at && pos < e.at + e.dur) idx = i;
    }
    // Only go through React when something visible changed (a few times per second, not per frame).
    if (lastVis.current.idx !== idx || lastVis.current.count !== count) {
      lastVis.current = { idx, count };
      setActiveIndex(idx);
      setHeard(count);
    }

    // Audio: keep ~2.5 s scheduled ahead.
    if (!enabledRef.current) return;
    const ctx = getAudio();
    if (!ctx || ctx.state !== "running") return;
    if (anchorRef.current === null) anchorRef.current = ctx.currentTime - elapsed / 1000;
    const anchor = anchorRef.current;
    const lastLoop = Math.floor((elapsed + 2500) / loopLen);
    try {
      for (let loop = scheduledUpTo.current + 1; loop <= lastLoop; loop++) {
        for (const ev of events) {
          if (ev.midi === null) continue;
          const atMs = loop * loopLen + ev.at;
          if (atMs > clock.duration) break;
          const when = anchor + atMs / 1000;
          if (when < ctx.currentTime) continue; // already in the past (late join)
          playTone(ctx, ev.midi, when, ev.dur * 0.95);
        }
        scheduledUpTo.current = loop;
      }
    } catch (err) {
      console.warn("piano scheduling failed", err);
    }
  });

  const enable = async () => {
    const ctx = getAudio();
    if (!ctx) return;
    await ctx.resume();
    setEnabled(ctx.state === "running");
  };

  useEffect(() => {
    const ctx = getAudio();
    if (ctx && ctx.state === "running") setEnabled(true);
  }, []);

  const activeMidi = activeIndex >= 0 ? events[activeIndex].midi : null;

  return (
    <div className="piano-stage">
      {!enabled && (
        <button className="btn teal sound-btn" onClick={enable}>🔊 Turn on sound</button>
      )}
      <div className="eyebrow">{enabled ? "Listen closely…" : "Sound is off"}</div>
      <Keys activeMidi={activeMidi} />
      <div className="note-bars">
        {events.slice(0, 48).map((e, i) => (
          <div
            key={i}
            className={`note-bar ${i < heard ? (i === activeIndex ? "now" : "heard") : ""}`}
            style={{ height: e.midi === null ? 4 : 8 + ((e.midi - 48) % 24) * 1.4 }}
          />
        ))}
      </div>
    </div>
  );
}

function Keys({ activeMidi }: { activeMidi: number | null }) {
  const lowest = 48; // C3
  const whites: number[] = [];
  for (let m = lowest; m <= 84; m++) if ([0, 2, 4, 5, 7, 9, 11].includes(m % 12)) whites.push(m);
  const kw = 26;
  const width = whites.length * kw;
  return (
    <svg viewBox={`0 0 ${width} 120`} className="piano-keys">
      <rect x={0} y={0} width={width} height={120} rx={8} fill="#2b1a2e" />
      {whites.map((m, i) => (
        <rect key={m} className={`key ${m === activeMidi ? "on" : ""}`} x={i * kw + 2} y={6} width={kw - 4} height={110} rx={4} />
      ))}
      {whites.map((m, i) => {
        const hasSharp = [0, 2, 5, 7, 9].includes(m % 12) && m + 1 <= 84;
        if (!hasSharp) return null;
        return <rect key={`b${m}`} className={`key black ${m + 1 === activeMidi ? "on" : ""}`} x={i * kw + kw - 8} y={6} width={16} height={66} rx={3} />;
      })}
    </svg>
  );
}
