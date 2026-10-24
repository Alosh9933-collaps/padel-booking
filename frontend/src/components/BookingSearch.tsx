import { useEffect, useRef, useState } from "react";

import { Api, type Booking } from "../api";
import { clockTime, dateIn, ltr, money, shortDate } from "../format";
import { useT } from "../i18n";
import { useClub } from "../session";

/** Find a booking by customer name or phone, newest first, and jump to it. */
export function BookingSearch({ onPick }: { onPick: (booking: Booking) => void }) {
  const t = useT();
  const { club } = useClub();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Booking[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.searchBookings(q)
        .then((list) => !cancelled && setResults(list))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [query]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="booking-search" ref={box}>
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder={`🔍 ${t("search.placeholder")}`}
        aria-label={t("search.placeholder")}
      />
      {open && results && (
        <ul className="suggest search-results" role="listbox">
          {results.length === 0 && <li className="muted small search-empty">{t("search.none")}</li>}
          {results.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  onPick(b);
                }}
              >
                <strong>{b.customer_name}</strong>
                <span className={b.status !== "confirmed" ? "muted" : ""}>{money(b.total, club.currency)}</span>
                <small>
                  {shortDate(dateIn(b.start_at, club.timezone))} · {ltr(clockTime(b.start_at, club.timezone))} · {b.court_name}
                  {b.status !== "confirmed" && ` · ${t(`status.${b.status}`)}`}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
