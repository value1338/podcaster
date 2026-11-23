import { CircleAlert, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { Button } from "./Button";
import "./ErrorState.css";

export interface ErrorStateProps {
  title?: string;
  /** Ursache + nächster Schritt in einem Satz. Bei error ohne message wird error.message genutzt. */
  message?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  /** Weitere Aktionen (z. B. Bergung). */
  actions?: ReactNode;
  /** kompakt = Zeile statt Block (z. B. in Listen/Menüs). */
  compact?: boolean;
}

/** Fehleranzeige mit Ausweg. Technische Details (Code/Status) aufklappbar. */
export function ErrorState({ title = "Etwas ist schiefgelaufen", message, error, onRetry, retryLabel = "Erneut versuchen", actions, compact }: ErrorStateProps) {
  const text = message ?? (error instanceof Error ? error.message : undefined);
  const tech = error instanceof ApiError ? `${error.code} · HTTP ${error.status || "–"}` : error instanceof Error ? error.name : null;
  return (
    <div className={compact ? "error error--compact" : "error"} role="alert">
      <CircleAlert className="error__icon" size={compact ? 18 : 28} aria-hidden />
      <div className="error__body">
        <p className="error__title">{title}</p>
        {text && <p className="error__text">{text}</p>}
        {tech && (
          <details className="error__details">
            <summary>Technische Details</summary>
            <code>{tech}</code>
          </details>
        )}
      </div>
      {(onRetry || actions) && (
        <div className="error__actions">
          {onRetry && <Button size={compact ? "sm" : "md"} icon={RotateCw} onClick={onRetry}>{retryLabel}</Button>}
          {actions}
        </div>
      )}
    </div>
  );
}
