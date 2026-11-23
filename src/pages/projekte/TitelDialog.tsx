import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components";

/** Modaler Titel-Dialog (Anlegen/Umbenennen) auf Basis von <dialog>: Fokusfalle und Esc kommen vom Browser. */
export function TitelDialog({ heading, submitLabel, initial = "", onSave, onClose }: {
  heading: string;
  submitLabel: string;
  initial?: string;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { ref.current?.showModal(); }, []);

  const t = title.trim();
  const valid = t.length >= 1 && t.length <= 120;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try { await onSave(t); }
    catch (err) { setError(err instanceof Error ? err.message : "Speichern fehlgeschlagen."); setBusy(false); }
  };

  return (
    <dialog ref={ref} className="projekte-dialog" aria-labelledby="projekte-dialog-titel"
      onCancel={(e) => { if (busy) e.preventDefault(); }} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id="projekte-dialog-titel">{heading}</h2>
        <label className="projekte-dialog__label" htmlFor="projekte-dialog-feld">Titel</label>
        <input id="projekte-dialog-feld" className="field projekte-dialog__feld" value={title} maxLength={120} autoFocus
          onChange={(e) => setTitle(e.target.value)} aria-invalid={!!error || undefined}
          aria-describedby="projekte-dialog-hinweis" disabled={busy} />
        <p id="projekte-dialog-hinweis" className={error ? "projekte-dialog__fehler" : "projekte-dialog__hinweis"} role={error ? "alert" : undefined}>
          {error ?? `${t.length}/120 Zeichen`}
        </p>
        <div className="projekte-dialog__aktionen">
          <Button variant="ghost" onClick={() => ref.current?.close()} disabled={busy}>Abbrechen</Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>{busy ? "Wird gespeichert …" : submitLabel}</Button>
        </div>
      </form>
    </dialog>
  );
}
