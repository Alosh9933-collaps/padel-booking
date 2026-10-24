import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";

interface ModalProps {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, subtitle, onClose, children, footer, wide = false }: ModalProps) {
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  // Parents re-render often (the schedule ticks every 30 s); keep the latest
  // onClose without re-running the mount effect, which would steal focus.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    const first = dialog.current?.querySelector<HTMLElement>(".modal-body input, .modal-body select");
    (first ?? dialog.current?.querySelector<HTMLElement>(".modal-foot button"))?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Rendered at the end of <body>, so a modal opened from inside a styled card
  // (dark backgrounds, transforms) never inherits its colours or clipping.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={dialog}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
