// Eigener Studio-Rahmen (ohne Seitenleiste, wie Referenz 02). Besitzer AP4.
import { Mic } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import "./Studio.css";

/** Eigener Rahmen des Studios: Marke + Kontext, rechts optional ein Ausgang. */
export function StudioRahmen({ kontext, ende, children }: { kontext?: ReactNode; ende?: ReactNode; children: ReactNode }) {
  return (
    <div className="studio">
      <header className="studio-kopf">
        <Link to="/" className="studio-kopf__marke" aria-label="Podcast-Studio – Startseite">
          <span className="studio-kopf__logo" aria-hidden><Mic size={16} /></span>
          <span className="studio-kopf__name">Podcast-Studio</span>
        </Link>
        {kontext && <span className="studio-kopf__kontext">{kontext}</span>}
        <span className="studio-kopf__ende">{ende}</span>
      </header>
      {children}
    </div>
  );
}

