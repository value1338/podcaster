import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

/** Klassen eines Buttons – auch für <a>/<Link> (z. B. Download-Links) verwenden. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string) {
  return ["btn", `btn--${variant}`, `btn--${size}`, extra].filter(Boolean).join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Nur Icon: children entfällt, aria-label ist dann Pflicht. */
  iconOnly?: boolean;
  children?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", icon: Icon, iconOnly, className, type = "button", children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, [iconOnly && "btn--icon", className].filter(Boolean).join(" "))} {...rest}>
      {Icon && <Icon size={size === "sm" ? 16 : 18} aria-hidden />}
      {children}
    </button>
  );
}
