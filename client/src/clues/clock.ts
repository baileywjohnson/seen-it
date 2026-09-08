import { useCallback, useEffect, useRef, useState } from "react";
import type { CluePhaseInfo } from "@shared";

export const STEPS = 5;

export interface ClueClock {
  duration: number;
  stepMs: number;
  /** Current reveal step (0..STEPS-1). React state: changes exactly at step boundaries. */
  step: number;
  /** Elapsed ms at the moment this clue mounted (lets CSS animations start mid-way for late joiners). */
  elapsedAtMount: number;
  /** Elapsed ms right now, clamped to [0, duration]. Cheap; safe to call every frame. */
  now(): number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Drives a clue from the server clock. Continuous animation should read `now()` inside a
 * requestAnimationFrame loop (see useRaf) or use CSS animations offset by `elapsedAtMount`;
 * only the discrete `step` goes through React state.
 */
export function useClueClock(clue: CluePhaseInfo, serverOffset: number): ClueClock {
  const offsetRef = useRef(serverOffset);
  offsetRef.current = serverOffset;
  const duration = clue.endsAt - clue.startsAt;
  const stepMs = duration / STEPS;
  const startsAt = clue.startsAt;
  const now = useCallback(() => clamp(Date.now() + offsetRef.current - startsAt, 0, duration), [startsAt, duration]);
  const [elapsedAtMount] = useState(now);
  const stepOf = (e: number) => Math.min(STEPS - 1, Math.floor(e / stepMs));
  const [step, setStep] = useState(() => stepOf(now()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const e = now();
      const s = Math.min(STEPS - 1, Math.floor(e / stepMs));
      setStep(s);
      if (s >= STEPS - 1) return;
      timer = setTimeout(schedule, Math.max(16, (s + 1) * stepMs - e + 4));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [now, stepMs]);

  return { duration, stepMs, step, elapsedAtMount, now };
}

/** Runs `draw(elapsedMs)` every animation frame while mounted. `draw` may change freely. */
export function useRaf(clock: ClueClock, draw: (elapsed: number) => void): void {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      drawRef.current(clock.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clock]);
}

/** Sizes a canvas to its CSS box at device pixel ratio (idempotent, cheap to call per frame). */
export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; W: number; H: number } {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 800;
  const H = canvas.clientHeight || 600;
  const pw = Math.round(W * dpr);
  const ph = Math.round(H * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOut = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
/** Progress (0..1) of the transition into `step`, given elapsed ms and a transition length. */
export const stepTransition = (clock: ClueClock, elapsed: number, step: number, ms: number) =>
  step === 0 ? 1 : easeInOut((elapsed - step * clock.stepMs) / ms);
