import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./EmptyState.css";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  text?: ReactNode;
  /** z. B. ein <Button> – nur echte, funktionierende Aktionen. */
  action?: ReactNode;
  /** Zusätzliches Element neben dem Titel, z. B. <Badge>. */
  badge?: ReactNode;
}

export function EmptyState({ icon: Icon, title, text, action, badge }: EmptyStateProps) {
  return (
    <div className="empty">
      {Icon && <div className="empty__icon"><Icon size={28} aria-hidden /></div>}
      <div className="empty__title"><h2>{title}</h2>{badge}</div>
      {text && <p className="empty__text">{text}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
