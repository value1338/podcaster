import { LogOut, Mic, ShieldCheck, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { api, type Usage } from "../lib/api";
import { formatSpeicher } from "../pages/konto/logik";
import { useKonto, useSitzung } from "../lib/sitzung";
import { NAV, NAV_GROUPS, STATUS_LABEL } from "../nav";
import { Badge } from "./Badge";
import { Menu } from "./Menu";
import "./Sidebar.css";

/** Feste linke Navigation nach Referenz 01/09. Unter 900 px als Schublade (open/onClose aus Shell). */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useKonto();
  return (
    <nav className={open ? "sidebar sidebar--open" : "sidebar"} aria-label="Hauptnavigation" id="hauptnavigation">
      <div className="sidebar__brand">
        <span className="sidebar__logo" aria-hidden><Mic size={16} /></span>
        <span className="sidebar__name">Podcast-Studio</span>
        <button type="button" className="sidebar__close btn btn--ghost btn--sm btn--icon" onClick={onClose} aria-label="Navigation schließen">
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="sidebar__scroll">
        {NAV_GROUPS.map((g) => (
          <div className="sidebar__group" key={g.id}>
            {g.title && <div className="sidebar__group-title">{g.title}</div>}
            <ul>
              {NAV.filter((n) => n.group === g.id && (!n.nur || n.nur === me.role)).map((n) => (
                <li key={n.path}>
                  <NavLink to={n.path} end={n.path === "/"} onClick={onClose}
                    className={({ isActive }) => (isActive ? "sidebar__item is-active" : "sidebar__item")}>
                    <n.icon size={20} strokeWidth={1.75} aria-hidden />
                    <span className="sidebar__label">{n.title}</span>
                    {n.status !== "aktiv" && <Badge tone={n.status}>{STATUS_LABEL[n.status]}</Badge>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Kontomenue onClose={onClose} />
    </nav>
  );
}

/** Kontomenü unten: Name, Plan, Speicheranzeige, Konto/Verwaltung/Abmelden (PA6). */
function Kontomenue({ onClose }: { onClose: () => void }) {
  const me = useKonto();
  const { abmelden } = useSitzung();
  const navigate = useNavigate();
  const [usage, setUsage] = useState<Usage | null | "fehler">(null);
  const [abmeldeFehler, setAbmeldeFehler] = useState(false);
  useEffect(() => { api.usage().then(setUsage, () => setUsage("fehler")); }, []);
  const geh = (p: string) => { onClose(); navigate(p); };
  const speicher = usage && usage !== "fehler" ? usage.storageBytes : null;
  return (
    <div className="sidebar__foot">
      <span className="sidebar__avatar" aria-hidden>{me.displayName.trim().charAt(0).toUpperCase() || "?"}</span>
      <div className="sidebar__konto">
        <span className="sidebar__konto-name">{me.displayName}</span>
        <span className="sidebar__konto-info">
          {me.plan.name}
          {speicher ? ` · ${formatSpeicher(speicher.used)}${speicher.limit !== null ? ` / ${formatSpeicher(speicher.limit)}` : ""}`
            : usage === "fehler" ? " · Verbrauch nicht verfügbar" : ""}
        </span>
        {abmeldeFehler && <span className="sidebar__konto-info sidebar__konto-fehler" role="alert">Abmelden fehlgeschlagen</span>}
      </div>
      <Menu label="Kontomenü" align="start" trigger={<UserRound size={18} aria-hidden />}
        triggerClassName="btn btn--ghost btn--sm btn--icon"
        items={[
          { label: "Konto & Verbrauch", icon: UserRound, onSelect: () => geh("/konto") },
          ...(me.role === "owner" ? [{ label: "Verwaltung", icon: ShieldCheck, onSelect: () => geh("/verwaltung") }] : []),
          { label: "Abmelden", icon: LogOut, onSelect: () => { setAbmeldeFehler(false); abmelden().catch(() => setAbmeldeFehler(true)); } },
        ]} />
    </div>
  );
}
