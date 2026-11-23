// /einladung/:token – Einladung, Ersteinrichtung, Kennwort-Rücksetzung (PA6, U2).
// Das Token bleibt nur im Speicher dieser Komponente: Adresse wird sofort ohne Token ersetzt,
// kein localStorage/sessionStorage/history.state, keine Konsolenausgabe.
import { KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, ErrorState, PageSpinner } from "../../components";
import { api, ApiError, type TokenInfo } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { neuLaden, useSitzung } from "../../lib/sitzung";
import { KontoRahmen } from "./Anmelden";
import { KENNWORT_MAX, KENNWORT_MIN, kennwortProblem, kontoFehlertext } from "./logik";

const TITEL: Record<TokenInfo["kind"], string> = {
  invite: "Einladung annehmen",
  setup: "Studio einrichten",
  reset: "Neues Kennwort festlegen",
};

export function EinladungSeite() {
  const params = useParams();
  const navigate = useNavigate();
  const [token] = useState(() => params.token ?? null);
  const { info: sitzung } = useSitzung();
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [ladeFehler, setLadeFehler] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [kennwort, setKennwort] = useState("");
  const [wiederholung, setWiederholung] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Token aus der Adresszeile entfernen (Verlauf/Teilen), Komponente bleibt dieselbe Route.
  useEffect(() => { if (params.token) navigate("/einladung", { replace: true }); }, [params.token, navigate]);

  useEffect(() => {
    if (!token) return;
    let aktiv = true;
    api.tokenInfo(token).then((i) => aktiv && setInfo(i), (e) => aktiv && setLadeFehler(e));
    return () => { aktiv = false; };
  }, [token]);

  if (!token) {
    return <KontoRahmen titel="Link öffnen"><p className="konto-hinweis">Bitte den vollständigen Link aus der Einladung oder vom Betreiber erneut öffnen. Aus Sicherheitsgründen wird er nach dem Neuladen nicht behalten.</p></KontoRahmen>;
  }
  if (ladeFehler != null) {
    const ungueltig = ladeFehler instanceof ApiError && (ladeFehler.code === "token_invalid" || ladeFehler.status === 429);
    return (
      <KontoRahmen titel="Link nicht verwendbar">
        {ungueltig
          ? <p className="konto-fehler" role="alert">{kontoFehlertext(ladeFehler)} Bitte beim Betreiber einen neuen Link anfordern.</p>
          : <ErrorState compact title="Link konnte nicht geprüft werden" error={ladeFehler} />}
      </KontoRahmen>
    );
  }
  if (!info) return <PageSpinner label="Link wird geprüft …" />;

  const einladung = info.kind === "invite";
  const angemeldet = sitzung?.user;

  async function senden(e: FormEvent) {
    e.preventDefault();
    const p = kennwortProblem(kennwort, wiederholung);
    if (p) { setProblem(p); return; }
    if (einladung && !name.trim()) { setProblem("Bitte einen Anzeigenamen angeben."); return; }
    setLaeuft(true);
    setProblem(null);
    try {
      await api.redeemToken(token!, {
        password: kennwort,
        ...(einladung ? { displayName: name.trim(), ...(info!.email ? {} : { email: email.trim() }) } : {}),
      });
      neuLaden("/"); // neue Sitzung → vollständiges Neuladen
    } catch (err) {
      setLaeuft(false);
      setProblem(kontoFehlertext(err));
    }
  }

  return (
    <KontoRahmen titel={TITEL[info.kind]}>
      <p className="u-muted">Link gültig bis {formatDateTime(info.expiresAt)} und nur einmal verwendbar.</p>
      {angemeldet && (
        <p className="konto-hinweis" role="status">
          Du bist in diesem Browser als <strong>{angemeldet.displayName}</strong> angemeldet. {einladung ? "Nach dem Annehmen bist du mit dem neuen Konto angemeldet." : "Nach dem Speichern bist du mit dem Konto dieses Links angemeldet."} Laufende Aufnahmen in anderen Tabs vorher abschließen.
        </p>
      )}
      <form className="konto-form" onSubmit={senden}>
        {einladung && (
          <>
            <label className="konto-feld">
              <span>E-Mail</span>
              {info.email
                ? <input className="field" type="email" value={info.email} readOnly autoComplete="username" />
                : <input className="field" type="email" required maxLength={254} autoComplete="username" value={email}
                    onChange={(e) => setEmail(e.target.value)} disabled={laeuft} />}
            </label>
            <label className="konto-feld">
              <span>Anzeigename</span>
              <input className="field" required maxLength={120} autoComplete="name" value={name}
                onChange={(e) => setName(e.target.value)} disabled={laeuft} />
            </label>
          </>
        )}
        {!einladung && info.email && <input type="email" hidden readOnly value={info.email} autoComplete="username" />}
        <label className="konto-feld">
          <span>Neues Kennwort <span className="u-muted">({KENNWORT_MIN}–{KENNWORT_MAX} Zeichen)</span></span>
          <input className="field" type="password" required maxLength={KENNWORT_MAX} autoComplete="new-password"
            value={kennwort} onChange={(e) => setKennwort(e.target.value)} disabled={laeuft} />
        </label>
        <label className="konto-feld">
          <span>Kennwort wiederholen</span>
          <input className="field" type="password" required maxLength={KENNWORT_MAX} autoComplete="new-password"
            value={wiederholung} onChange={(e) => setWiederholung(e.target.value)} disabled={laeuft} />
        </label>
        {info.kind === "reset" && <p className="u-muted konto-zaehler__klein">Alle bisherigen Sitzungen dieses Kontos werden beendet.</p>}
        {problem && <p className="konto-fehler" role="alert">{problem}</p>}
        <Button type="submit" variant="primary" icon={KeyRound} disabled={laeuft}>
          {laeuft ? "Wird gespeichert …" : einladung ? "Konto anlegen" : "Kennwort speichern"}
        </Button>
      </form>
    </KontoRahmen>
  );
}
