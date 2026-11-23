import { Link } from "react-router";
import { Badge, buttonClass, EmptyState } from "../components";
import { type NavEntry, STATUS_LABEL } from "../nav";

/** Einheitliche Seite für nicht implementierte Bereiche: Badge + ein Satz, keine Schein-Bedienelemente. */
export function Platzhalter({ entry }: { entry: NavEntry }) {
  const status = entry.status === "aktiv" ? "spaeter" : entry.status;
  return (
    <div className="page">
      <EmptyState
        icon={entry.icon}
        title={entry.title}
        badge={<Badge tone={status}>{STATUS_LABEL[status]}</Badge>}
        text={
          <>
            {entry.text}
            <br />
            {status === "tbd" ? "Dieser Bereich ist vorgemerkt." : "In dieser Version noch nicht verfügbar."}
          </>
        }
        action={<Link to="/" className={buttonClass("secondary")}>Zur Startseite</Link>}
      />
    </div>
  );
}

export function NichtGefunden() {
  return (
    <div className="page">
      <EmptyState title="Seite nicht gefunden" text="Diese Adresse gibt es im Podcast-Studio nicht."
        action={<Link to="/" className={buttonClass("secondary")}>Zur Startseite</Link>} />
    </div>
  );
}
