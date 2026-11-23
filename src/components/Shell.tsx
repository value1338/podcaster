import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import "./Shell.css";

/** App-Rahmen: Seitenleiste + Inhaltstafel mit Kopfzeile. Seiten rendern in <Outlet/>. Studio läuft ohne Shell. */
export function Shell() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  return (
    <div className="shell">
      <a href="#inhalt" className="shell__skip">Zum Inhalt springen</a>
      <Sidebar open={open} onClose={() => setOpen(false)} />
      {open && <div className="shell__backdrop" onClick={() => setOpen(false)} aria-hidden />}
      <div className="shell__panel">
        <Topbar menuOpen={open} onMenu={() => setOpen(true)} />
        <main className="shell__main" id="inhalt" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
