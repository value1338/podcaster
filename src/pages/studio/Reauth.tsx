// Erneute Anmeldung direkt im Studio (PA7, V §11) – ohne Navigation und ohne Neuladen, damit Aufnahme und Engine weiterlaufen.
import { LogIn, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ErrorState } from "../../components";
import { api, ApiError } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import type { Studio, StudioSnapshot } from "../../lib/recorder";

/**
 * Nur das Konto `userId`, das die Aufnahme begonnen hat, darf sie fortsetzen. Ein anderes Konto wird sofort wieder abgemeldet
 * (es sieht nichts und sendet nichts). Ohne laufende Sicherung (`geschuetzt` false) ist ein anderes Konto ein normaler
 * Kontowechsel: dann laut Vertrag vollständiges Neuladen der App-Basis.
 * Undurchsichtig, damit ein fremdes Konto vor der Prüfung nichts vom Studio sieht.
 */
export function Reauth({ userId, geschuetzt, s, studio, onFertig }: {
  userId: string; geschuetzt: boolean; s: StudioSnapshot; studio: Studio | null; onFertig(): void;
}) {
  const [email, setEmail] = useState("");
  const [kennwort, setKennwort] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<unknown>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // Anderes Konto per Login/Einladungslink in einem anderen Tab? (Cookie gilt für alle Tabs.) Nur für den Hinweistext.
  const [fremd, setFremd] = useState(false);
  useEffect(() => {
    const pruefen = () => api.session().then((si) => setFremd(!!si.user && si.user.id !== userId), () => {});
    void pruefen();
    const t = setInterval(pruefen, 5000); // ponytail: Text folgt Wechseln in anderen Tabs; Senden prüft die Engine selbst
    return () => clearInterval(t);
  }, [userId]);
  const grund = fremd
    ? "In diesem Browser ist inzwischen ein anderes Konto angemeldet (z. B. in einem anderen Tab). Für dieses Studio wird nichts gesendet oder angezeigt."
    : "Die Sitzung ist abgelaufen.";

  async function senden(e: FormEvent) {
    e.preventDefault();
    setLaeuft(true);
    setFehler(null);
    try {
      const { user } = await api.login(email.trim(), kennwort);
      setKennwort("");
      if (user.id === userId) {
        window.dispatchEvent(new Event("studio:angemeldet")); // Engine sendet sofort weiter, PA6 erneuert den Sitzungszustand
        onFertig();
        return;
      }
      if (!geschuetzt) { window.location.assign(import.meta.env.BASE_URL); return; } // regulärer Kontowechsel
      await api.logout().catch(() => {}); // fremdes Konto sofort wieder entfernen; Engine sendet ohnehin nur für userId
      setFehler(new ApiError(403, "falsches_konto", "Mit diesem Konto wurde die Aufnahme nicht begonnen. Es wurde wieder abgemeldet; bitte mit dem ursprünglichen Konto anmelden."));
    } catch (err) {
      setFehler(err);
    } finally {
      setLaeuft(false);
    }
  }

  const wartend = s.chunks.total - s.chunks.uploaded;
  const titel = fehler instanceof ApiError
    ? fehler.code === "invalid_credentials" ? "E-Mail oder Kennwort falsch"
      : fehler.code === "rate_limited" ? "Zu viele Versuche"
      : fehler.code === "falsches_konto" ? "Falsches Konto" : "Anmeldung fehlgeschlagen"
    : "Anmeldung fehlgeschlagen";
  const warte = fehler instanceof ApiError && typeof fehler.details.retryAfterS === "number" ? ` Bitte ${Math.ceil(fehler.details.retryAfterS / 60)} min warten.` : "";

  return (
    <div className="studio-reauth" role="dialog" aria-modal="true" aria-labelledby="studio-reauth-titel" data-testid="studio-reauth">
      <form className="studio-reauth__karte" onSubmit={senden}>
        <h1 id="studio-reauth-titel" className="studio-block__titel"><LogIn size={20} aria-hidden /> Bitte erneut anmelden</h1>
        {geschuetzt ? (
          <p className="studio-klein">
            {grund} {s.phase === "aufnahme" ? <>Die Aufnahme läuft weiter (<span className="u-mono">{formatDuration(s.elapsedMs)}</span>) und </> : "Die Aufnahme "}
            wird in diesem Browser gesichert{wartend > 0 ? ` – ${wartend} ${wartend === 1 ? "Abschnitt wartet" : "Abschnitte warten"} auf den Server` : ""}.
            Nach der Anmeldung mit demselben Konto wird automatisch weiter übertragen.
          </p>
        ) : (
          <p className="studio-klein">{grund} Nach der Anmeldung mit dem Konto dieses Studios geht es hier weiter; ein anderes Konto lädt die App neu.</p>
        )}
        <div className="studio-feld">
          <label htmlFor="studio-reauth-email">E-Mail</label>
          <input id="studio-reauth-email" ref={ref} className="field" type="email" autoComplete="username" required value={email}
            onChange={(e) => setEmail(e.target.value)} disabled={laeuft} />
        </div>
        <div className="studio-feld">
          <label htmlFor="studio-reauth-kennwort">Kennwort</label>
          <input id="studio-reauth-kennwort" className="field" type="password" autoComplete="current-password" required value={kennwort}
            onChange={(e) => setKennwort(e.target.value)} disabled={laeuft} />
        </div>
        {fehler != null && <ErrorState compact title={titel} error={fehler} message={fehler instanceof Error ? fehler.message + warte : undefined} />}
        <div className="studio-aktionen">
          <Button type="submit" variant="primary" icon={LogIn} disabled={laeuft || !email.trim() || !kennwort}>{laeuft ? "Wird angemeldet …" : "Anmelden"}</Button>
          {s.phase === "aufnahme" && <Button variant="danger" icon={Square} onClick={() => void studio?.stop()}>Aufnahme beenden</Button>}
        </div>
        {s.phase === "aufnahme" && <p className="studio-klein u-muted">Beenden sichert alles lokal; übertragen wird nach der Anmeldung.</p>}
      </form>
    </div>
  );
}
