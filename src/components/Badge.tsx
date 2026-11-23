import type { ReactNode } from "react";
import "./Badge.css";

export type BadgeTone = "neutral" | "tbd" | "spaeter" | "accent" | "ok" | "warn" | "error" | "rec";

/** Kleines Statusschild. "tbd" und "spaeter" sind die zwei Platzhalter-Kennzeichnungen (Scope §4). */
export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return <span className={`badge badge--${tone}`} title={title}>{children}</span>;
}
