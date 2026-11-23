// /anmelden – öffentlich, ohne Shell (PA6, U1/U5).
import { LogIn, Mic } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Button, ErrorState, PageSpinner } from "../../components";
import { api, ApiError } from "../../lib/api";
import { neuLaden, sicheresZiel, useSitzung } from "../../lib/sitzung";
import { formatWarten, kontoFehlertext, wartezeit } from "./logik";
import "./konto.css";

const GRUND: Record<string, string> = {
  abgemeldet: "Du wurdest abgemeldet.",
  abgelaufen: "Deine Sitzung ist abgelaufen oder wurde beendet. Bitte melde dich erneut an.",
  kennwort: "Kennwort geändert. Alle Sitzungen wurden beendet – bitte mit dem neuen Kennwort anmelden.",
};

/** Zentrierter Rahmen für öffentliche Kontoseiten. */
export function KontoRahmen({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <div className="konto-rahmen">
      <main className="konto-karte" id="inhalt">
        <div className="konto-marke"><span className="sidebar__logo" aria-hidden><Mic size={16} /></span>Podcast-Studio</div>
        <h1>{titel}</h1>
        {children}
      </main>
    </div>
  );
}

/** Hinweis bei setup_required – kein Formular, keine Geheimnisse. */
export function EinrichtungFehlt() {
  return (
    <div className="konto-hinweis" role="status">
      <p><strong>Das Studio ist noch nicht eingerichtet.</strong> Die Einrichtung erfolgt lokal durch den Betreiber; über diese Seite lässt sich kein Konto anlegen.</p>
      <p className="u-muted">Betreiber: Ist <code>STUDIO_ADMIN_EMAIL</code> gesetzt, legt der Server beim Start einen Einmal-Einrichtungslink in <code>admin-einrichtung.txt</code> im Datenverzeichnis ab (zusätzlich einmal im Server-Log). Link öffnen und Kennwort setzen. Abgelaufen? Server neu starten.</p>
      <p className="u-muted">Ohne <code>STUDIO_ADMIN_EMAIL</code>: auf dem Server als Dienstnutzer <code>node server/cli.mjs owner:create --email … --name … --output &lt;neue Datei&gt;</code> ausführen und den Link aus der geschützten Datei öffnen (30 Minuten gültig).</p>
    </div>
  );
}

export function AnmeldenSeite() {
  const { info, fehler, laden } = useSitzung();
  const [suche] = useSearchParams();
  const ziel = sicheresZiel(suche.get("weiter"));
  const grund = GRUND[suche.get("grund") ?? ""];
  const [email, setEmail] = useState("");
  const [kennwort, setKennwort] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [warten, setWarten] = useState(0);
  const [setup, setSetup] = useState(false);

  useEffect(() => {
    if (warten <= 0) return;
    const t = setTimeout(() => setWarten((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [warten]);

  if (fehler != null) return <KontoRahmen titel="Anmelden"><ErrorState title="Studio nicht erreichbar" error={fehler} onRetry={laden} compact /></KontoRahmen>;
  if (!info) return <PageSpinner label="Anmeldung wird geprüft …" />;
  if (info.user) return <Navigate to={ziel} replace />;
  if (info.setupRequired || setup) return <KontoRahmen titel="Anmelden"><EinrichtungFehlt /></KontoRahmen>;

  async function senden(e: FormEvent) {
    e.preventDefault();
    setLaeuft(true);
    setProblem(null);
    try {
      await api.login(email.trim(), kennwort);
      neuLaden(ziel); // vollständiges Neuladen: kein Zustand im Tab übernehmen
    } catch (err) {
      setLaeuft(false);
      setKennwort("");
      if (err instanceof ApiError && err.code === "setup_required") { setSetup(true); return; }
      setWarten(wartezeit(err) ?? 0);
      setProblem(err);
    }
  }

  const technisch = problem instanceof ApiError && (problem.isNetwork || problem.status >= 500);
  return (
    <KontoRahmen titel="Anmelden">
      {grund && <p className="konto-hinweis" role="status">{grund}</p>}
      <form className="konto-form" onSubmit={senden} noValidate={false}>
        <label className="konto-feld">
          <span>E-Mail</span>
          <input className="field" type="email" autoComplete="username" required value={email} maxLength={254}
            onChange={(e) => setEmail(e.target.value)} disabled={laeuft} autoFocus />
        </label>
        <label className="konto-feld">
          <span>Kennwort</span>
          <input className="field" type="password" autoComplete="current-password" required value={kennwort} maxLength={200}
            onChange={(e) => setKennwort(e.target.value)} disabled={laeuft} />
        </label>
        {problem != null && (technisch
          ? <ErrorState compact title="Anmeldung nicht möglich" error={problem} />
          : <p className="konto-fehler" role="alert">{warten > 0 ? `Zu viele Versuche. Bitte in ${formatWarten(warten)} erneut versuchen.` : kontoFehlertext(problem)}</p>)}
        <Button type="submit" variant="primary" icon={LogIn} disabled={laeuft || warten > 0 || !email.trim() || !kennwort}>
          {laeuft ? "Wird angemeldet …" : "Anmelden"}
        </Button>
      </form>
      <p className="u-muted konto-zaehler__klein">Kein Konto? Zugang gibt es nur per Einladungslink vom Betreiber. Kennwort vergessen? Den Betreiber um einen Rücksetz-Link bitten.</p>
    </KontoRahmen>
  );
}
