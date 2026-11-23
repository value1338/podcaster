// Anzeigeformate (deutsch). Besitzer: AP0.

/** 76_000 → "00:01:16"; null → "–". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "–";
  const t = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

/** 1536 → "1,5 KB" (Basis 1024, eine Nachkommastelle ab KB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} B` : `${v.toLocaleString("de-DE", { maximumFractionDigits: 1 })} ${units[i]}`;
}

/** ISO → "20. Nov. 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
}

/** ISO → "20. Nov. 2026, 14:05". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString("de-DE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 1920,1080 → "1920×1080"; fehlend → "". */
export function formatResolution(w: number | null | undefined, h: number | null | undefined): string {
  return w && h ? `${w}×${h}` : "";
}

/** 1 → "1 Aufnahme", 3 → "3 Aufnahmen". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
