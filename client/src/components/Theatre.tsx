import type { ReactNode } from "react";

export function Theatre({ children, phase }: { children: ReactNode; phase: string }) {
  return (
    <div className={`theatre phase-${phase}`}>
      <div className="seats" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <div className="stage-area">{children}</div>
    </div>
  );
}

export function Marquee({ title, sub, icon }: { title: string; sub?: string; icon?: string }) {
  return (
    <div className="marquee">
      <h1>
        {title}
        {icon && <span className="marquee-icon" aria-hidden="true">{icon}</span>}
      </h1>
      {sub && <p className="sub">{sub}</p>}
    </div>
  );
}

/** Coloured initial for a player; hue is derived from the name so it's stable everywhere. */
export function Avatar({ name, small }: { name: string; small?: boolean }) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span className={`avatar ${small ? "sm" : ""}`} style={{ ["--hue" as string]: h }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
