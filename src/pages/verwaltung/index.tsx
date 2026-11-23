// /verwaltung – nur Eigentümer (PA6, U4). Bereiche per ?bereich= (keine neue Route).
// Teile, die der Server noch nicht liefert (PA2/PA5), zeigen ehrlich „noch nicht verfügbar“.
import { Ban, KeyRound, Plus, RotateCw, Trash2, UserCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Badge, Button, ErrorState } from "../../components";
import { api, type AdminUser, type Invite, type InviteLink, type Plan, type Settings, type SettingsPatch } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useKonto } from "../../lib/sitzung";
import { kontoFehlertext } from "../konto/logik";
import { Abrufzustand, LinkAnzeige, useAbruf, Verbrauch, Zaehler } from "../konto/teile";
import { aktuellePeriode, ausEingabe, einladungsStatus, formatUsd, httpWarnung, MITGLIEDS_PLAENE, PLAN_FELDER, zuEingabe } from "./logik";
import "../konto/konto.css";
import "./verwaltung.css";

const BEREICHE = [
  ["konten", "Konten"], ["einladungen", "Einladungen"], ["plaene", "Pläne"],
  ["verbrauch", "Verbrauch"], ["einstellungen", "Einstellungen"], ["archiv", "Archiv"],
] as const;
type Bereich = (typeof BEREICHE)[number][0];

export function VerwaltungSeite() {
  const [suche, setSuche] = useSearchParams();
  const b = suche.get("bereich");
  const bereich: Bereich = BEREICHE.some(([id]) => id === b) ? (b as Bereich) : "konten";
  return (
    <div className="page verwaltung">
      <div className="page__head"><h1>Verwaltung</h1></div>
      <div className="verwaltung-reiter" role="tablist" aria-label="Verwaltungsbereiche">
        {BEREICHE.map(([id, titel]) => (
          <button key={id} type="button" role="tab" id={`vw-tab-${id}`} aria-selected={bereich === id} aria-controls="vw-panel"
            className={bereich === id ? "verwaltung-reiter__tab is-aktiv" : "verwaltung-reiter__tab"}
            onClick={() => setSuche(id === "konten" ? {} : { bereich: id }, { replace: true })}>{titel}</button>
        ))}
      </div>
      <section id="vw-panel" role="tabpanel" aria-labelledby={`vw-tab-${bereich}`} className="verwaltung-panel">
        {bereich === "konten" && <Konten />}
        {bereich === "einladungen" && <Einladungen />}
        {bereich === "plaene" && <Plaene />}
        {bereich === "verbrauch" && <VerbrauchUebersicht />}
        {bereich === "einstellungen" && <Einstellungen />}
        {bereich === "archiv" && <Archiv />}
      </section>
    </div>
  );
}

const STATUS: Record<AdminUser["status"], [string, "ok" | "error" | "warn"]> = {
  active: ["aktiv", "ok"], disabled: ["gesperrt", "error"], pending: ["Einrichtung offen", "warn"],
};

function Konten() {
  const ich = useKonto();
  const liste = useAbruf(() => api.admin.users());
  const [link, setLink] = useState<{ fuer: string; link: InviteLink } | null>(null);
  const [aktion, setAktion] = useState<{ id: string; fehler: unknown } | null>(null);

  async function ausfuehren(id: string, f: () => Promise<unknown>) {
    setAktion({ id, fehler: null });
    try { await f(); setAktion(null); liste.laden(); }
    catch (e) { setAktion({ id, fehler: e }); }
  }
  const aendern = (u: AdminUser, patch: Parameters<typeof api.admin.updateUser>[1]) =>
    ausfuehren(u.id, async () => { const neu = await api.admin.updateUser(u.id, patch); liste.setDaten((l) => l && l.map((x) => (x.id === u.id ? { ...x, ...neu } : x))); });

  return (
    <Abrufzustand titel="Konten" fehler={liste.fehler} laedt={!liste.daten} onRetry={liste.laden}>
      {() => (
        <>
          {link && <LinkAnzeige art={`Rücksetz-Link für ${link.fuer}`} url={link.link.url} expiresAt={link.link.expiresAt} onFertig={() => setLink(null)} />}
          <ul className="verwaltung-liste">
            {liste.daten!.map((u) => {
              const [st, ton] = STATUS[u.status];
              const eigen = u.role === "owner";
              const beschaeftigt = aktion?.id === u.id && aktion.fehler == null;
              return (
                <li key={u.id} className="verwaltung-zeile">
                  <div className="verwaltung-zeile__kopf">
                    <div className="verwaltung-zeile__name">
                      <strong>{u.displayName}</strong>{u.id === ich.id && <span className="u-muted"> (du)</span>}
                      <div className="u-muted verwaltung-klein">{u.email}</div>
                    </div>
                    <div className="verwaltung-zeile__badges">
                      {eigen && <Badge tone="accent">Eigentümer</Badge>}
                      <Badge tone={ton}>{st}</Badge>
                    </div>
                  </div>
                  <div className="verwaltung-zeile__info u-muted verwaltung-klein">
                    Angelegt {formatDateTime(u.createdAt)} · letzte Anmeldung {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "nie"}
                  </div>
                  {u.usage
                    ? <Verbrauch usage={u.usage} />
                    : <p className="u-muted verwaltung-klein">Verbrauch: vom Server noch nicht bereitgestellt.</p>}
                  <div className="verwaltung-zeile__aktionen">
                    <label className="verwaltung-inline">
                      <span>Plan</span>
                      {eigen
                        ? <span className="u-mono">{u.planId}</span>
                        : <select className="verwaltung-select" value={u.planId} disabled={beschaeftigt}
                            onChange={(e) => aendern(u, { planId: e.target.value })}>
                            {MITGLIEDS_PLAENE.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>}
                    </label>
                    {!eigen && (u.status === "disabled"
                      ? <Button size="sm" icon={UserCheck} disabled={beschaeftigt} onClick={() => aendern(u, { status: "active" })}>Entsperren</Button>
                      : <Button size="sm" icon={Ban} disabled={beschaeftigt}
                          onClick={() => window.confirm(`${u.displayName} sperren? Alle Sitzungen enden sofort, Daten bleiben erhalten.`) && aendern(u, { status: "disabled" })}>Sperren</Button>)}
                    {u.status !== "disabled" && !eigen && (
                      <Button size="sm" icon={KeyRound} disabled={beschaeftigt}
                        onClick={() => ausfuehren(u.id, async () => setLink({ fuer: u.displayName, link: await api.admin.resetLink(u.id) }))}>
                        Rücksetz-Link
                      </Button>
                    )}
                    {eigen && <span className="u-muted verwaltung-klein">Eigentümer: Rücksetzen nur lokal über die CLI (<code>owner:link</code>).</span>}
                  </div>
                  {aktion?.id === u.id && aktion.fehler != null && <p className="konto-fehler" role="alert">{kontoFehlertext(aktion.fehler)}</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Abrufzustand>
  );
}

function Einladungen() {
  const liste = useAbruf(() => api.admin.invites());
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<string>("free");
  const [stunden, setStunden] = useState("168");
  const [laeuft, setLaeuft] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<InviteLink | null>(null);
  const [widerruf, setWiderruf] = useState<{ id: string; fehler: unknown } | null>(null);

  async function anlegen(e: FormEvent) {
    e.preventDefault();
    const h = Number(stunden);
    if (!Number.isInteger(h) || h < 1 || h > 336) { setProblem("Gültigkeit: 1 bis 336 Stunden."); return; }
    setLaeuft(true); setProblem(null); setLink(null);
    try {
      setLink(await api.admin.createInvite({ planId: plan, expiresInHours: h, ...(email.trim() ? { email: email.trim() } : {}) }));
      setEmail("");
      liste.laden();
    } catch (err) { setProblem(kontoFehlertext(err)); }
    finally { setLaeuft(false); }
  }

  async function zurueckziehen(i: Invite) {
    if (!window.confirm("Einladung widerrufen? Der Link funktioniert danach nicht mehr.")) return;
    setWiderruf({ id: i.id, fehler: null });
    try { await api.admin.revokeInvite(i.id); setWiderruf(null); liste.laden(); }
    catch (e) { setWiderruf({ id: i.id, fehler: e }); }
  }

  return (
    <div className="verwaltung-stapel">
      <form className="verwaltung-formular" onSubmit={anlegen}>
        <h2>Neue Einladung</h2>
        <div className="verwaltung-felder">
          <label className="konto-feld"><span>E-Mail (optional, bindet den Link)</span>
            <input className="field" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={laeuft} /></label>
          <label className="konto-feld"><span>Plan</span>
            <select className="verwaltung-select" value={plan} onChange={(e) => setPlan(e.target.value)} disabled={laeuft}>
              {MITGLIEDS_PLAENE.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></label>
          <label className="konto-feld"><span>Gültig (Stunden, 1–336)</span>
            <input className="field" inputMode="numeric" required value={stunden} onChange={(e) => setStunden(e.target.value)} disabled={laeuft} /></label>
        </div>
        {problem && <p className="konto-fehler" role="alert">{problem}</p>}
        <div><Button type="submit" variant="primary" icon={Plus} disabled={laeuft}>{laeuft ? "Wird erzeugt …" : "Einladungslink erzeugen"}</Button></div>
      </form>
      {link && <LinkAnzeige art="Einladungslink" url={link.url} expiresAt={link.expiresAt} onFertig={() => setLink(null)} />}

      <h2>Einladungen</h2>
      <Abrufzustand titel="Einladungen" fehler={liste.fehler} laedt={!liste.daten} onRetry={liste.laden}>
        {() => liste.daten!.length === 0 ? <p className="u-muted">Noch keine Einladungen.</p> : (
          <ul className="verwaltung-liste">
            {[...liste.daten!].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((i) => {
              const st = einladungsStatus(i);
              return (
                <li key={i.id} className="verwaltung-zeile">
                  <div className="verwaltung-zeile__kopf">
                    <div className="verwaltung-zeile__name">
                      <strong>{i.email ?? "ohne feste E-Mail"}</strong>
                      <div className="u-muted verwaltung-klein">Plan <span className="u-mono">{i.planId}</span> · erstellt {formatDateTime(i.createdAt)} · gültig bis {formatDateTime(i.expiresAt)}{i.usedAt && ` · benutzt ${formatDateTime(i.usedAt)}`}</div>
                    </div>
                    <div className="verwaltung-zeile__badges">
                      <Badge tone={st === "offen" ? "accent" : st === "benutzt" ? "ok" : "neutral"}>{st}</Badge>
                      {!i.usedAt && <Button size="sm" variant="ghost" icon={Trash2} disabled={widerruf?.id === i.id && widerruf.fehler == null}
                        onClick={() => zurueckziehen(i)}>Widerrufen</Button>}
                    </div>
                  </div>
                  {widerruf?.id === i.id && widerruf.fehler != null && <p className="konto-fehler" role="alert">{kontoFehlertext(widerruf.fehler)}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Abrufzustand>
    </div>
  );
}

function Plaene() {
  const liste = useAbruf(() => api.admin.plans());
  return (
    <Abrufzustand titel="Pläne" fehler={liste.fehler} laedt={!liste.daten} onRetry={liste.laden}>
      {() => (
        <div className="verwaltung-stapel">
          <p className="u-muted verwaltung-klein">Vorläufige Arbeitswerte, keine Verkaufspreise. Leeres Feld = unbegrenzt.</p>
          {liste.daten!.map((p) => <PlanFormular key={p.id} plan={p} onGespeichert={(neu) => liste.setDaten((l) => l && l.map((x) => (x.id === neu.id ? neu : x)))} />)}
        </div>
      )}
    </Abrufzustand>
  );
}

function PlanFormular({ plan, onGespeichert }: { plan: Plan; onGespeichert: (p: Plan) => void }) {
  const [werte, setWerte] = useState(() => Object.fromEntries(PLAN_FELDER.map((f) => [f.key, zuEingabe(plan[f.key], f.faktor)])));
  const [status, setStatus] = useState<{ laeuft: boolean; text: string | null; ok: boolean }>({ laeuft: false, text: null, ok: false });

  async function speichern(e: FormEvent) {
    e.preventDefault();
    let neu: Plan;
    try {
      neu = { ...plan, ...Object.fromEntries(PLAN_FELDER.map((f) => [f.key, ausEingabe(werte[f.key], f.faktor)])) };
    } catch (err) { setStatus({ laeuft: false, text: (err as Error).message, ok: false }); return; }
    setStatus({ laeuft: true, text: null, ok: false });
    try { const g = await api.admin.savePlan(neu); onGespeichert(g); setStatus({ laeuft: false, text: "Gespeichert.", ok: true }); }
    catch (err) { setStatus({ laeuft: false, text: kontoFehlertext(err), ok: false }); }
  }

  return (
    <form className="verwaltung-formular" onSubmit={speichern}>
      <h2>{plan.name} <span className="u-muted u-mono verwaltung-klein">{plan.id}</span></h2>
      <div className="verwaltung-felder">
        {PLAN_FELDER.map((f) => (
          <label key={f.key} className="konto-feld"><span>{f.label} ({f.einheit})</span>
            <input className="field u-mono" inputMode="decimal" placeholder="unbegrenzt" value={werte[f.key]} disabled={status.laeuft}
              onChange={(e) => setWerte((w) => ({ ...w, [f.key]: e.target.value }))} /></label>
        ))}
      </div>
      {status.text && <p className={status.ok ? "u-muted" : "konto-fehler"} role={status.ok ? "status" : "alert"}>{status.text}</p>}
      <div><Button type="submit" disabled={status.laeuft}>{status.laeuft ? "Wird gespeichert …" : "Plan speichern"}</Button></div>
    </form>
  );
}

function VerbrauchUebersicht() {
  const [periode, setPeriode] = useState(aktuellePeriode);
  const daten = useAbruf(() => api.admin.usage(periode), [periode]);
  const d = daten.daten;
  return (
    <div className="verwaltung-stapel">
      <label className="verwaltung-inline"><span>Zeitraum</span>
        <input className="field" type="month" value={periode} onChange={(e) => e.target.value && setPeriode(e.target.value)} /></label>
      <Abrufzustand titel="Verbrauch" fehler={daten.fehler} laedt={!d} onRetry={daten.laden}>
        {() => (
          <>
            <h2>Plattform gesamt</h2>
            <div className="konto-zaehler-raster">
              <Zaehler titel="Text-KI-Token" m={d!.platform.llmTokens} einheit="token" />
              <Zaehler titel="Transkription" m={d!.platform.asrSeconds} einheit="sekunden" />
              <div className="konto-zaehler">
                <div className="konto-zaehler__kopf"><span>Text-KI-Kosten</span></div>
                <div className="konto-zaehler__wert u-mono">{formatUsd(d!.platform.llmCostMicro.used + d!.platform.llmCostMicro.reserved)} von {formatUsd(d!.platform.llmCostMicro.limit)}</div>
              </div>
            </div>
            <h2>Je Konto</h2>
            {d!.users.length === 0 ? <p className="u-muted">Keine Konten.</p> : (
              <ul className="verwaltung-liste">
                {d!.users.map((u) => (
                  <li key={u.userId} className="verwaltung-zeile">
                    <div className="verwaltung-zeile__kopf"><strong>{u.email}</strong><span className="u-mono u-muted">{formatUsd(u.llmCostMicro)}</span></div>
                    <Verbrauch usage={u.usage} />
                  </li>
                ))}
              </ul>
            )}
            {d!.unclear.length > 0 && (
              <>
                <h2>Unklare Text-KI-Aufrufe</h2>
                <p className="u-muted verwaltung-klein">Anfrage wurde gesendet, Ergebnis unklar; Reservierung freigegeben. Beim Anbieter prüfen.</p>
                <ul className="verwaltung-liste">
                  {d!.unclear.map((x) => (
                    <li key={x.jobId} className="verwaltung-zeile verwaltung-klein">
                      <span className="u-mono">{x.jobId}</span> · Konto <span className="u-mono">{x.userId}</span> · {formatDateTime(x.at)} · {x.reservedTokens.toLocaleString("de-DE")} Token
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Abrufzustand>
    </div>
  );
}

function Einstellungen() {
  const daten = useAbruf(() => api.admin.settings());
  return (
    <Abrufzustand titel="Einstellungen" fehler={daten.fehler} laedt={!daten.daten} onRetry={daten.laden}>
      {() => <EinstellungsFormular s={daten.daten!} onGespeichert={(s) => daten.setDaten(s)} />}
    </Abrufzustand>
  );
}

function EinstellungsFormular({ s, onGespeichert }: { s: Settings; onGespeichert: (s: Settings) => void }) {
  const [f, setF] = useState(() => ({
    llmModel: s.llmModel,
    preisEin: s.llmPrices ? zuEingabe(s.llmPrices.inputMicroPerMTok, 1e6) : "",
    preisAus: s.llmPrices ? zuEingabe(s.llmPrices.outputMicroPerMTok, 1e6) : "",
    token: zuEingabe(s.llmGlobalTokensMonth, 1),
    kosten: zuEingabe(s.llmGlobalCostMicroMonth, 1e6),
    gpu: s.asrRequireGpu,
    fenster: String(s.asrWindowSeconds),
    archiv: s.archiveMode,
    auslagern: s.archiveEvictAfterDays === null ? "" : String(s.archiveEvictAfterDays),
    llmUrl: s.llmBaseUrl, llmKey: "", llmKeyWeg: false, aufwand: s.llmReasoningEffort ?? "", llmZeit: String(s.llmTimeoutMs / 1000),
    asrUrl: s.asrUrl, asrToken: "", asrTokenWeg: false, asrZeit: String(s.asrTimeoutMs / 1000),
  }));
  const [status, setStatus] = useState<{ laeuft: boolean; text: string | null; ok: boolean }>({ laeuft: false, text: null, ok: false });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function speichern(e: FormEvent) {
    e.preventDefault();
    let patch: SettingsPatch;
    try {
      if (f.llmModel !== s.llmModel && !/^[A-Za-z0-9._:-]{1,64}$/.test(f.llmModel)) throw new Error("Modellname: 1–64 Zeichen aus A–Z, a–z, 0–9, . _ : -");
      const ein = ausEingabe(f.preisEin, 1e6), aus = ausEingabe(f.preisAus, 1e6);
      if ((ein === null) !== (aus === null)) throw new Error("Preise: beide Werte angeben oder beide leer lassen.");
      const fenster = Number(f.fenster);
      if (!Number.isInteger(fenster) || fenster < 60 || fenster > 1200) throw new Error("ASR-Fenster: ganze Sekunden von 60 bis 1200.");
      const llmZeit = Number(f.llmZeit), asrZeit = Number(f.asrZeit);
      if (!Number.isInteger(llmZeit) || llmZeit < 1 || llmZeit > 120) throw new Error("Text-KI-Zeitlimit: ganze Sekunden von 1 bis 120.");
      if (!Number.isInteger(asrZeit) || asrZeit < 1 || asrZeit > 3600) throw new Error("Spracherkennung-Zeitlimit: ganze Sekunden von 1 bis 3600.");
      for (const [name, url] of [["Text-KI-Adresse", f.llmUrl], ["Spracherkennung-Adresse", f.asrUrl]]) {
        if (url.trim() && (!/^https?:\/\/[^\s?#@]+$/.test(url.trim()))) throw new Error(`${name}: http(s)-Adresse ohne Zugangsdaten, ? oder #.`);
      }
      patch = {
        llmModel: f.llmModel,
        llmPrices: ein === null || aus === null ? null : { inputMicroPerMTok: ein, outputMicroPerMTok: aus },
        llmGlobalTokensMonth: ausEingabe(f.token, 1),
        llmGlobalCostMicroMonth: ausEingabe(f.kosten, 1e6),
        asrRequireGpu: f.gpu,
        asrWindowSeconds: fenster,
        archiveMode: f.archiv,
        archiveEvictAfterDays: ausEingabe(f.auslagern, 1),
        llmBaseUrl: f.llmUrl.trim(),
        llmReasoningEffort: f.aufwand === "" ? null : (f.aufwand as Settings["llmReasoningEffort"]),
        llmTimeoutMs: llmZeit * 1000,
        asrUrl: f.asrUrl.trim(),
        asrTimeoutMs: asrZeit * 1000,
      };
      // Nur Geändertes senden (z. B. bleibt ein noch leerer Modellname unangetastet).
      patch = Object.fromEntries(Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(s[k as keyof Settings])));
      // Secrets: leer = unverändert, Haken = entfernen.
      if (f.llmKeyWeg) patch.llmApiKey = null; else if (f.llmKey.trim()) patch.llmApiKey = f.llmKey.trim();
      if (f.asrTokenWeg) patch.asrToken = null; else if (f.asrToken.trim()) patch.asrToken = f.asrToken.trim();
      if (!Object.keys(patch).length) { setStatus({ laeuft: false, text: "Keine Änderung.", ok: true }); return; }
    } catch (err) { setStatus({ laeuft: false, text: (err as Error).message, ok: false }); return; }
    setStatus({ laeuft: true, text: null, ok: false });
    try {
      onGespeichert(await api.admin.saveSettings(patch));
      setF((x) => ({ ...x, llmKey: "", llmKeyWeg: false, asrToken: "", asrTokenWeg: false }));
      setStatus({ laeuft: false, text: "Gespeichert.", ok: true });
    }
    catch (err) { setStatus({ laeuft: false, text: kontoFehlertext(err), ok: false }); }
  }

  const d = status.laeuft;
  const geheim = (k: "llmKey" | "asrToken", weg: "llmKeyWeg" | "asrTokenWeg", gesetzt: boolean, titel: string) => (
    <div className="konto-feld">
      <label className="konto-feld"><span>{titel}</span>
        <input className="field u-mono" type="password" autoComplete="new-password" spellCheck={false}
          placeholder={gesetzt ? "gesetzt – leer lassen = unverändert" : "nicht gesetzt"}
          value={f[k]} onChange={set(k)} disabled={d || f[weg]} /></label>
      {gesetzt && <label className="verwaltung-inline"><input type="checkbox" checked={f[weg]} onChange={(e) => setF((x) => ({ ...x, [weg]: e.target.checked }))} disabled={d} /><span>Entfernen</span></label>}
    </div>
  );
  const warnLlm = httpWarnung(f.llmUrl.trim()) && (s.llmApiKeySet || !!f.llmKey.trim()) && !f.llmKeyWeg;
  const warnAsr = httpWarnung(f.asrUrl.trim()) && (s.asrTokenSet || !!f.asrToken.trim()) && !f.asrTokenWeg;
  return (
    <form className="verwaltung-formular" onSubmit={speichern}>
      <h2>KI-Dienste</h2>
      <p className="u-muted verwaltung-klein">Ohne Adresse und Schlüssel bleiben Text-KI bzw. Transkription abgeschaltet. Schlüssel werden nie wieder angezeigt.</p>
      <h3 className="verwaltung-unterkopf">Text-KI (OpenAI-kompatibel)</h3>
      <div className="verwaltung-felder">
        <label className="konto-feld"><span>Basis-URL</span><input className="field u-mono" type="url" spellCheck={false} placeholder="https://api.openai.com/v1" value={f.llmUrl} onChange={set("llmUrl")} disabled={d} /></label>
        {geheim("llmKey", "llmKeyWeg", s.llmApiKeySet, "API-Schlüssel")}
        <label className="konto-feld"><span>Reasoning effort</span>
          <select className="verwaltung-select" value={f.aufwand} onChange={set("aufwand")} disabled={d}>
            <option value="">nicht senden</option><option value="none">none</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select></label>
        <label className="konto-feld"><span>Zeitlimit (Sekunden, 1–120)</span><input className="field u-mono" inputMode="numeric" value={f.llmZeit} onChange={set("llmZeit")} disabled={d} /></label>
      </div>
      {warnLlm && <p className="konto-fehler verwaltung-klein" role="alert">Achtung: Der API-Schlüssel geht unverschlüsselt (http) an einen anderen Rechner. Nur im vertrauenswürdigen Netz verwenden.</p>}
      <h3 className="verwaltung-unterkopf">Spracherkennung</h3>
      <div className="verwaltung-felder">
        <label className="konto-feld"><span>Dienst-URL</span><input className="field u-mono" type="url" spellCheck={false} placeholder="https://asr.example.org" value={f.asrUrl} onChange={set("asrUrl")} disabled={d} /></label>
        {geheim("asrToken", "asrTokenWeg", s.asrTokenSet, "Token")}
        <label className="konto-feld"><span>Zeitlimit je Anfrage (Sekunden, 1–3600)</span><input className="field u-mono" inputMode="numeric" value={f.asrZeit} onChange={set("asrZeit")} disabled={d} /></label>
      </div>
      {warnAsr && <p className="konto-fehler verwaltung-klein" role="alert">Achtung: Das Token geht unverschlüsselt (http) an einen anderen Rechner. Nur im vertrauenswürdigen Netz verwenden.</p>}
      <h2>Text-KI</h2>
      <div className="verwaltung-felder">
        <label className="konto-feld"><span>Modell</span><input className="field u-mono" value={f.llmModel} onChange={set("llmModel")} disabled={d} /></label>
        <label className="konto-feld"><span>Preis Eingabe (USD je 1 Mio. Token)</span><input className="field u-mono" inputMode="decimal" placeholder="nicht gepflegt" value={f.preisEin} onChange={set("preisEin")} disabled={d} /></label>
        <label className="konto-feld"><span>Preis Ausgabe (USD je 1 Mio. Token)</span><input className="field u-mono" inputMode="decimal" placeholder="nicht gepflegt" value={f.preisAus} onChange={set("preisAus")} disabled={d} /></label>
        <label className="konto-feld"><span>Plattform-Deckel Token / Monat</span><input className="field u-mono" inputMode="numeric" placeholder="unbegrenzt" value={f.token} onChange={set("token")} disabled={d} /></label>
        <label className="konto-feld"><span>Plattform-Deckel Kosten / Monat (USD)</span><input className="field u-mono" inputMode="decimal" placeholder="unbegrenzt" value={f.kosten} onChange={set("kosten")} disabled={d} /></label>
      </div>
      <h2>Transkription</h2>
      <div className="verwaltung-felder">
        <label className="verwaltung-inline"><input type="checkbox" checked={f.gpu} onChange={(e) => setF((x) => ({ ...x, gpu: e.target.checked }))} disabled={d} /><span>Nur mit GPU transkribieren (kein stiller CPU-Betrieb)</span></label>
        <label className="konto-feld"><span>Fenstergröße (Sekunden, 60–1200)</span><input className="field u-mono" inputMode="numeric" value={f.fenster} onChange={set("fenster")} disabled={d} /></label>
      </div>
      <h2>Archiv</h2>
      <div className="verwaltung-felder">
        <label className="konto-feld"><span>Modus</span>
          <select className="verwaltung-select" value={f.archiv} onChange={(e) => setF((x) => ({ ...x, archiv: e.target.value as Settings["archiveMode"] }))} disabled={d}>
            <option value="off">aus</option><option value="manual">manuell</option><option value="auto">automatisch</option>
          </select></label>
        <label className="konto-feld"><span>Lokal auslagern nach (Tagen)</span><input className="field u-mono" inputMode="numeric" placeholder="nie" value={f.auslagern} onChange={set("auslagern")} disabled={d} /></label>
      </div>
      {status.text && <p className={status.ok ? "u-muted" : "konto-fehler"} role={status.ok ? "status" : "alert"}>{status.text}</p>}
      <div><Button type="submit" variant="primary" disabled={d}>{d ? "Wird gespeichert …" : "Einstellungen speichern"}</Button></div>
    </form>
  );
}

const ARCHIV_ZUSTAND = { ready: "bereit", configuration_required: "Einrichtung fehlt", unavailable: "nicht erreichbar" } as const;

function Archiv() {
  const daten = useAbruf(() => api.admin.archive());
  const a = daten.daten;
  return (
    <Abrufzustand titel="Archivstatus" fehler={daten.fehler} laedt={!a} onRetry={daten.laden}>
      {() => (
        <div className="verwaltung-stapel">
          <div className="verwaltung-zeile__kopf">
            <Badge tone={a!.state === "ready" ? "ok" : "warn"}>{ARCHIV_ZUSTAND[a!.state]}</Badge>
            <Button size="sm" icon={RotateCw} onClick={daten.laden}>Erneut prüfen</Button>
          </div>
          <dl className="konto-daten">
            <dt>Treiber</dt><dd className="u-mono">{a!.driver ?? "–"}</dd>
            <dt>Archiv-Kennung</dt><dd className="u-mono">{a!.archiveId ?? "–"}</dd>
            <dt>Frei</dt><dd className="u-mono">{a!.freeBytes === null ? "–" : formatBytes(a!.freeBytes)}</dd>
            <dt>Geprüft</dt><dd>{formatDateTime(a!.checkedAt)}</dd>
            <dt>Ausgelagert</dt><dd className="u-mono">{a!.evicted}</dd>
            {Object.entries(a!.counts).map(([k, n]) => <div key={k} className="verwaltung-contents"><dt>Spuren „{k}“</dt><dd className="u-mono">{n}</dd></div>)}
          </dl>
          {a!.error && <ErrorState compact title="Letzter Fehler" message={a!.error} />}
        </div>
      )}
    </Abrufzustand>
  );
}
