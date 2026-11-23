// /konto – Profil, Verbrauch, Kennwortwechsel, Abmelden (PA6, U3).
import { KeyRound, LogOut } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge, Button, ErrorState } from "../../components";
import { api } from "../../lib/api";
import { anmeldePfad, neuLaden, useKonto, useSitzung } from "../../lib/sitzung";
import { KENNWORT_MAX, KENNWORT_MIN, kennwortProblem, kontoFehlertext } from "./logik";
import { Abrufzustand, useAbruf, Verbrauch } from "./teile";
import "./konto.css";

export { AnmeldenSeite } from "./Anmelden";
export { EinladungSeite } from "./Einladung";

export function KontoSeite() {
  const me = useKonto();
  const verbrauch = useAbruf(() => api.usage());
  return (
    <div className="page konto-seite">
      <div className="page__head"><h1>Konto</h1><AbmeldenKnopf /></div>

      <section className="konto-abschnitt" aria-labelledby="konto-profil">
        <h2 id="konto-profil">Profil</h2>
        <dl className="konto-daten">
          <dt>Name</dt><dd>{me.displayName}</dd>
          <dt>E-Mail</dt><dd>{me.email}</dd>
          <dt>Rolle</dt><dd>{me.role === "owner" ? <Badge tone="accent">Eigentümer</Badge> : "Mitglied"}</dd>
          <dt>Plan</dt><dd>{me.plan.name} <span className="u-muted u-mono">({me.plan.id})</span></dd>
        </dl>
        <p className="u-muted konto-zaehler__klein">Planwechsel nimmt nur der Betreiber vor.</p>
      </section>

      <section className="konto-abschnitt" aria-labelledby="konto-verbrauch">
        <h2 id="konto-verbrauch">Verbrauch</h2>
        <Abrufzustand titel="Verbrauch" fehler={verbrauch.fehler} laedt={!verbrauch.daten} onRetry={verbrauch.laden}>
          {() => <Verbrauch usage={verbrauch.daten!} />}
        </Abrufzustand>
      </section>

      <section className="konto-abschnitt" aria-labelledby="konto-kennwort">
        <h2 id="konto-kennwort">Kennwort ändern</h2>
        <KennwortForm />
      </section>
    </div>
  );
}

export function AbmeldenKnopf({ variant = "secondary" }: { variant?: "secondary" | "ghost" }) {
  const { abmelden } = useSitzung();
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<unknown>(null);
  return (
    <>
      <Button variant={variant} icon={LogOut} disabled={laeuft}
        onClick={() => { setLaeuft(true); setFehler(null); abmelden().then((erfolgt) => { if (!erfolgt) setLaeuft(false); }).catch((e) => { setLaeuft(false); setFehler(e); }); }}>
        {laeuft ? "Wird abgemeldet …" : "Abmelden"}
      </Button>
      {fehler != null && <ErrorState compact title="Abmelden fehlgeschlagen" error={fehler} />}
    </>
  );
}

function KennwortForm() {
  const me = useKonto();
  const [aktuell, setAktuell] = useState("");
  const [neu, setNeu] = useState("");
  const [wiederholung, setWiederholung] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function senden(e: FormEvent) {
    e.preventDefault();
    const p = kennwortProblem(neu, wiederholung);
    if (p) { setProblem(p); return; }
    setLaeuft(true);
    setProblem(null);
    try {
      await api.changePassword(aktuell, neu);
      // Server beendet alle Sitzungen inkl. der aktuellen → neu anmelden.
      neuLaden(anmeldePfad(undefined, "kennwort"));
    } catch (err) {
      setLaeuft(false);
      setAktuell("");
      setProblem(kontoFehlertext(err));
    }
  }

  return (
    <form className="konto-form konto-form--schmal" onSubmit={senden}>
      <input type="email" hidden readOnly value={me.email} autoComplete="username" />
      <label className="konto-feld">
        <span>Aktuelles Kennwort</span>
        <input className="field" type="password" required maxLength={KENNWORT_MAX} autoComplete="current-password"
          value={aktuell} onChange={(e) => setAktuell(e.target.value)} disabled={laeuft} />
      </label>
      <label className="konto-feld">
        <span>Neues Kennwort <span className="u-muted">({KENNWORT_MIN}–{KENNWORT_MAX} Zeichen)</span></span>
        <input className="field" type="password" required maxLength={KENNWORT_MAX} autoComplete="new-password"
          value={neu} onChange={(e) => setNeu(e.target.value)} disabled={laeuft} />
      </label>
      <label className="konto-feld">
        <span>Neues Kennwort wiederholen</span>
        <input className="field" type="password" required maxLength={KENNWORT_MAX} autoComplete="new-password"
          value={wiederholung} onChange={(e) => setWiederholung(e.target.value)} disabled={laeuft} />
      </label>
      <p className="u-muted konto-zaehler__klein">Danach werden alle Sitzungen beendet – auch diese. Du meldest dich anschließend neu an.</p>
      {problem && <p className="konto-fehler" role="alert">{problem}</p>}
      <div><Button type="submit" variant="primary" icon={KeyRound} disabled={laeuft || !aktuell || !neu}>
        {laeuft ? "Wird geändert …" : "Kennwort ändern"}
      </Button></div>
    </form>
  );
}
