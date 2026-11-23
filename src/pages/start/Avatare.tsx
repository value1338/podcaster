// Eigene, flache Agenten-Figuren (keine fremden Markenfiguren). Rein dekorativ → aria-hidden.
// ponytail: Illustrationsfarben stehen hier im SVG, nicht in tokens.css – sie sind Inhalt, keine UI-Signalfarben.
import type { ReactNode } from "react";
import type { RolleId } from "./agenten";

const Gesicht = ({ haut }: { haut: string }) => (
  <>
    <circle cx="36" cy="38" r="20" fill={haut} />
    <circle cx="29" cy="37" r="2.4" fill="#1b1030" />
    <circle cx="43" cy="37" r="2.4" fill="#1b1030" />
    <path d="M30 46q6 5 12 0" stroke="#1b1030" strokeWidth="2.2" fill="none" strokeLinecap="round" />
  </>
);

const FIGUREN: Record<RolleId, ReactNode> = {
  // Producer: Headset mit Mikrofonarm
  producer: (
    <>
      <path d="M14 30q0-22 22-22t22 22v2h-5v-2q0-17-17-17t-17 17v2h-5z" fill="#2a1f4d" />
      <Gesicht haut="#a78bfa" />
      <rect x="10" y="30" width="8" height="14" rx="4" fill="#2a1f4d" />
      <rect x="54" y="30" width="8" height="14" rx="4" fill="#2a1f4d" />
      <path d="M14 43q2 12 16 12" stroke="#2a1f4d" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="31" cy="55" r="3.6" fill="#f4f0ff" />
    </>
  ),
  // Editor: runde Brille, Stift hinterm Ohr
  editor: (
    <>
      <path d="M16 34q0-20 20-20t20 20q-6-9-20-9t-20 9z" fill="#0f3d3a" />
      <Gesicht haut="#5eead4" />
      <circle cx="29" cy="37" r="6" fill="none" stroke="#0f3d3a" strokeWidth="2.4" />
      <circle cx="43" cy="37" r="6" fill="none" stroke="#0f3d3a" strokeWidth="2.4" />
      <path d="M35 37h2" stroke="#0f3d3a" strokeWidth="2.4" />
      <rect x="52" y="16" width="5" height="22" rx="1.5" transform="rotate(25 54 27)" fill="#fbbf24" />
    </>
  ),
  // Clipper: Schirmmütze nach hinten, Filmklappe
  clipper: (
    <>
      <path d="M17 32q0-18 19-18t19 18z" fill="#7c2d12" />
      <path d="M50 30q10-1 14 4h-14z" fill="#7c2d12" />
      <Gesicht haut="#fdba74" />
      <g transform="rotate(-12 18 56)">
        <rect x="6" y="52" width="22" height="14" rx="2" fill="#1f1f1f" />
        <path d="M6 48h22v5H6z" fill="#f2f2f2" />
        <path d="M10 48l3 5M16 48l3 5M22 48l3 5" stroke="#1f1f1f" strokeWidth="2" />
      </g>
    </>
  ),
  // Marketer: Haartolle, Megafon
  marketer: (
    <>
      <path d="M18 30q2-20 22-18q14 2 14 16q-8-8-18-6q-10 1-18 8z" fill="#831843" />
      <Gesicht haut="#f9a8d4" />
      <path d="M50 50l14-8v20l-14-8z" fill="#f2f2f2" />
      <rect x="45" y="49" width="7" height="8" rx="2" fill="#831843" />
      <path d="M66 46q3 6 0 12" stroke="#f2f2f2" strokeWidth="2" fill="none" strokeLinecap="round" />
    </>
  ),
};

export function Avatar({ rolle }: { rolle: RolleId }) {
  return (
    <svg className="start-agent__avatar" viewBox="0 0 72 72" width="72" height="72" aria-hidden focusable="false">
      {FIGUREN[rolle]}
    </svg>
  );
}
