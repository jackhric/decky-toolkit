import { CSSProperties, useEffect, useRef } from "react";
import { Mark } from "./Mark";

type Puff = { x: number; y: number; vy: number; age: number; life: number; phase: number; r: number };

// Same colour as the site's --steam.
const RGB = "255,255,255";
const ALPHA = 0.5;
// Puffs overlap heavily, so each one carries only a share of the target opacity.
const PUFF_ALPHA = ALPHA * 0.35;
const RATE = 14;

// A cheap 2D take on the site's WebGL steam (site/src/components/hero/SteamLogo.astro): soft puffs
// leave the mug rim, rise, sway more the higher they get, swell and fade.
function Steam({ size }: { size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Wider than the mark so swelling puffs are not clipped at the sides.
  const pad = size * 0.25;
  const w = size + pad * 2;
  const h = size * 0.8;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);

    // Rim of the mug in mark.svg's viewBox (x 178-434 of 140-620), as a fraction of the width.
    const x0 = pad + size * 0.08;
    const x1 = pad + size * 0.61;
    const puffs: Puff[] = [];
    let raf = 0;
    let last = 0;
    let spawn = 0;

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
      last = ts;
      for (spawn += dt * RATE; spawn >= 1; spawn--) {
        puffs.push({
          x: x0 + Math.random() * (x1 - x0),
          y: 0,
          vy: h * (0.22 + Math.random() * 0.12),
          age: 0,
          life: 2.4 + Math.random() * 1.2,
          phase: Math.random() * Math.PI * 2,
          r: size * (0.07 + Math.random() * 0.04),
        });
      }
      ctx.clearRect(0, 0, w, h);
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        p.age += dt;
        if (p.age >= p.life) {
          puffs.splice(i, 1);
          continue;
        }
        p.y += p.vy * dt;
        p.x += Math.sin(p.age * 1.7 + p.phase) * (p.y / h) * size * 0.12 * dt;
        const t = p.age / p.life;
        const a = PUFF_ALPHA * Math.min(1, p.age / 0.4) * Math.pow(1 - t, 1.4);
        const r = p.r + p.y * 0.3;
        const cy = h - p.y;
        const g = ctx.createRadialGradient(p.x, cy, 0, p.x, cy, r);
        g.addColorStop(0, `rgba(${RGB},${a})`);
        g.addColorStop(1, `rgba(${RGB},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(p.x - r, cy - r, r * 2, r * 2);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [w, h, pad, size]);

  // The rim sits 13 viewBox units below the top of the mark.
  const rim = (size * 470) / 480 * (13 / 470);
  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ position: "absolute", left: -pad, top: rim - h, width: w, height: h, pointerEvents: "none" }}
    />
  );
}

export function SteamingMark({ size = 96, steaming, className, style }: { size?: number; steaming: boolean; className?: string; style?: CSSProperties }) {
  return (
    <div className={className} style={{ position: "relative", lineHeight: 0, ...style }}>
      <Mark size={size} />
      {steaming && <Steam size={size} />}
    </div>
  );
}
