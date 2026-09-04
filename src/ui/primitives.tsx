import type { ReactNode } from "react";

export function Wordmark({ onClick }: { onClick?: () => void }) {
  const content = (
    <>
      <span className="wordmark__mark" aria-hidden="true" />
      <span className="wordmark__text">Monoprint</span>
    </>
  );
  return onClick
    ? <button type="button" className="wordmark wordmark--button" onClick={onClick}>{content}</button>
    : <div className="wordmark">{content}</div>;
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  disabled,
  onClick,
  title,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button type={type} className={`btn btn--${variant} btn--${size} ${className}`} disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function StatusDot({ tone }: { tone: "idle" | "busy" | "ok" | "warn" | "bad" }) {
  return <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />;
}

export function formatDate(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function elapsedLabel(start: string, end?: string) {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
