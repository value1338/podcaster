import { ungesicherteAufnahmen } from "./recorder/pending";
// Sitzungszustand der Oberfläche (PA6). Vertrag: Plattform-Vertraege.md §5.1, §6, §11.
// - Geschützte Inhalte erst nach bestätigter Sitzung (GET /api/session).
// - An-/Abmelden endet mit vollständigem Neuladen der App-Basis (kein Zustand eines anderen Kontos im Tab).
// - studio:abgemeldet auf /studio/:id löst NICHTS aus (kein Redirect/Unmount/Reload) – PA7 meldet dort selbst neu an
//   und sendet danach studio:angemeldet. Verlässt man das Studio mit abgelaufener Sitzung, wird neu geladen.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { ErrorState, PageSpinner } from "../components";
import { api, ApiError, type Me, type SessionInfo } from "./api";

const BASIS = import.meta.env.BASE_URL; // "/" oder "/podcast/"

/** Vollständiges Neuladen an einem Pfad innerhalb der App-Basis (pfad beginnt mit "/"). */
export function neuLaden(pfad = "/") {
  const ziel = BASIS + sichererAppPfad(pfad).replace(/^\/+/, "");
  const url = new URL(ziel, window.location.href);
  window.location.assign(url.origin === window.location.origin ? url.href : BASIS);
}

/** URL-Sicherheit für interne Navigation; Anmeldeseiten sind hier zulässig. */
function sichererAppPfad(weiter: string | null | undefined): string {
  if (!weiter || !weiter.startsWith("/") || weiter.startsWith("//") || weiter.includes("\\") || /[\s\x00-\x20\x7f]/u.test(weiter)) return "/";
  return weiter;
}

/** Ein weiter-Ziel darf nicht wieder auf die Anmeldung oder Einlösung zeigen. */
export function sicheresZiel(weiter: string | null | undefined): string {
  const ziel = sichererAppPfad(weiter);
  return /^\/(anmelden|einladung)(\/|\?|$)/.test(ziel) ? "/" : ziel;
}

/** /studio/:projektId – dort gehört der Sitzungsablauf dem Studio (PA7). */
export const istStudioRaum = (pfad: string) => /^\/studio\/[^/]+/.test(pfad);

export function anmeldePfad(weiter?: string, grund?: string) {
  const q = new URLSearchParams();
  const ziel = sicheresZiel(weiter);
  if (ziel !== "/") q.set("weiter", ziel);
  if (grund) q.set("grund", grund);
  return `/anmelden${q.size ? `?${q}` : ""}`;
}

interface SitzungsWert {
  info: SessionInfo | null;   // null = lädt noch
  fehler: unknown;
  laden: () => void;
  /** Abmelden mit anschließendem Neuladen. Wirft bei Netzfehler (Anzeige beim Aufrufer). */
  abmelden: () => Promise<boolean>;
}

const Ctx = createContext<SitzungsWert | null>(null);

export function SitzungProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [fehler, setFehler] = useState<unknown>(null);
  const userId = useRef<string | null>(null);

  const laden = useCallback(() => {
    setFehler(null);
    setInfo(null);
    api.session().then((s) => { userId.current = s.user?.id ?? null; setInfo(s); }, setFehler);
  }, []);
  useEffect(laden, [laden]);

  // Nach erneuter Anmeldung im Studio (PA7): Anzeige aktualisieren, ohne etwas abzubauen.
  useEffect(() => {
    const an = () => {
      api.session().then((s) => {
        // ponytail: PA7 garantiert dieselbe userId; weicht sie ab, bleibt die alte Anzeige bis zum nächsten Neuladen.
        if (s.user && s.user.id === userId.current) setInfo(s);
      }, () => { /* Anzeige bleibt; nächster Abruf zeigt den Fehler */ });
    };
    window.addEventListener("studio:angemeldet", an);
    return () => window.removeEventListener("studio:angemeldet", an);
  }, []);

  const abmelden = useCallback(async () => {
    let anzahl: number;
    try { anzahl = userId.current ? await ungesicherteAufnahmen(userId.current) : 0; }
    catch {
      if (!window.confirm("Lokale Aufnahmen konnten nicht geprüft werden. Trotzdem abmelden? Die lokal gespeicherten Daten bleiben erhalten.")) return false;
      anzahl = 0;
    }
    if (anzahl > 0 && !window.confirm(`${anzahl} Aufnahme(n) sind noch nicht vollständig gesichert. Trotzdem abmelden? Melde dich mit demselben Konto erneut an, um sie wiederherzustellen.`)) return false;
    try {
      await api.logout();
    } catch (e) {
      // Bereits abgemeldet ist für den Nutzer dasselbe Ergebnis.
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    neuLaden(anmeldePfad(undefined, "abgemeldet"));
    return true;
  }, []);

  return <Ctx.Provider value={{ info, fehler, laden, abmelden }}>{children}</Ctx.Provider>;
}

export function useSitzung(): SitzungsWert {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSitzung außerhalb von SitzungProvider");
  return v;
}

/** Angemeldetes Konto – nur innerhalb von <Geschuetzt> verwenden. */
export function useKonto(): Me {
  const user = useSitzung().info?.user;
  if (!user) throw new Error("useKonto ohne Sitzung");
  return user;
}

/** Layout-Route: rendert geschützte Inhalte erst nach bestätigter Sitzung. */
export function Geschuetzt() {
  const { info, fehler, laden } = useSitzung();
  const { pathname, search } = useLocation();
  const pfad = useRef(pathname);
  pfad.current = pathname;
  const [abgelaufen, setAbgelaufen] = useState(false);

  useEffect(() => {
    const ab = () => {
      if (istStudioRaum(pfad.current)) setAbgelaufen(true); // Studio bleibt gemountet
      else neuLaden(anmeldePfad(pfad.current + window.location.search, "abgelaufen"));
    };
    const an = () => setAbgelaufen(false);
    window.addEventListener("studio:abgemeldet", ab);
    window.addEventListener("studio:angemeldet", an);
    return () => { window.removeEventListener("studio:abgemeldet", ab); window.removeEventListener("studio:angemeldet", an); };
  }, []);

  const verlassen = abgelaufen && !istStudioRaum(pathname);
  useEffect(() => {
    if (verlassen) neuLaden(anmeldePfad(pathname + search, "abgelaufen"));
  }, [verlassen, pathname, search]);

  if (fehler != null) {
    return <div className="page"><ErrorState title="Sitzung konnte nicht geprüft werden" error={fehler} onRetry={laden} /></div>;
  }
  if (!info || verlassen) return <PageSpinner label="Anmeldung wird geprüft …" />;
  if (!info.user) return <Navigate to={anmeldePfad(pathname + search)} replace />;
  return <Outlet />;
}

/** Nur für den Eigentümer; Mitglieder sehen dieselbe Seite wie bei unbekannten Adressen. */
export function NurEigentuemer({ children, sonst }: { children: ReactNode; sonst: ReactNode }) {
  return useKonto().role === "owner" ? <>{children}</> : <>{sonst}</>;
}
