import { useEffect, useRef } from "react";

interface Particle {
  x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; color: string; life: number;
}
const COLORS = ["#f9c846", "#c8323d", "#2ec4b6", "#ff8fab", "#9ad7f5", "#fff4dc"];

/** A short confetti burst on its own canvas; re-fires whenever `burst` changes. */
export function Confetti({ burst }: { burst: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!burst) return;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const parts: Particle[] = Array.from({ length: 110 }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 380 + Math.random() * 420;
      return {
        x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.7,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        w: 6 + Math.random() * 8, h: 4 + Math.random() * 6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)], life: 1.6 + Math.random() * 0.6,
      };
    });
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of parts) {
        p.life -= dt;
        if (p.life <= 0) continue;
        alive++;
        p.vy += 900 * dt;
        p.vx *= 0.99;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [burst]);
  return <canvas ref={ref} className="confetti" />;
}
