import { Menu as MenuIcon, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import "./Topbar.css";

/**
 * Kopfzeile: mittiges Suchfeld, sonst nur Funktionierendes.
 * Suche (Stufe 1): navigiert zu /projekte?q=… – AP5 filtert dort Projekt-/Aufnahmetitel.
 */
export function Topbar({ menuOpen, onMenu }: { menuOpen: boolean; onMenu: () => void }) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const urlQ = pathname === "/projekte" ? params.get("q") ?? "" : "";
  const [q, setQ] = useState(urlQ);
  useEffect(() => setQ(urlQ), [urlQ]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = q.trim();
    const next = new URLSearchParams(pathname === "/projekte" ? params : undefined);
    if (t) next.set("q", t);
    else next.delete("q");
    navigate(`/projekte${next.size ? `?${next}` : ""}`);
  };

  return (
    <header className="topbar">
      <button type="button" className="topbar__menu btn btn--ghost btn--md btn--icon" onClick={onMenu}
        aria-label="Navigation öffnen" aria-expanded={menuOpen} aria-controls="hauptnavigation">
        <MenuIcon size={20} aria-hidden />
      </button>
      <form className="topbar__search" role="search" onSubmit={submit}>
        <Search size={18} aria-hidden className="topbar__search-icon" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Suchen"
          aria-label="Projekte und Aufnahmen nach Titel suchen" enterKeyHint="search" />
      </form>
      <div className="topbar__end" />
    </header>
  );
}
