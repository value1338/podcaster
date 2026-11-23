import { LoaderCircle } from "lucide-react";
import "./Spinner.css";

/** Ladeanzeige. label wird vorgelesen (role=status); visible zeigt den Text daneben. */
export function Spinner({ size = 20, label = "Lädt …", visible = false }: { size?: number; label?: string; visible?: boolean }) {
  return (
    <span className="spinner" role="status">
      <LoaderCircle className="spinner__icon" size={size} aria-hidden />
      <span className={visible ? "spinner__label" : "u-sr-only"}>{label}</span>
    </span>
  );
}

/** Zentrierte Ladeanzeige für ganze Seiten/Bereiche. */
export function PageSpinner({ label = "Lädt …" }: { label?: string }) {
  return <div className="spinner-page"><Spinner size={28} label={label} visible /></div>;
}
