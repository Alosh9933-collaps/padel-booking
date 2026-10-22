import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import type { Club } from "./api";

interface ClubContextValue {
  club: Club;
  clubs: Club[];
  canManage: boolean;
  selectClub: (id: number) => void;
  replaceClub: (club: Club) => void;
}

export const ClubContext = createContext<ClubContextValue | null>(null);

export function useClub(): ClubContextValue {
  const value = useContext(ClubContext);
  if (!value) throw new Error("useClub() must be used inside the app shell.");
  return value;
}

type ToastKind = "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((text: string, kind: ToastKind = "success") => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, kind, text }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-dot" aria-hidden />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
