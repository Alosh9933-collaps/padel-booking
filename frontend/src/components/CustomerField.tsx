import { useEffect, useState } from "react";

import { Api, type Customer } from "../api";
import { useT } from "../i18n";
import { useClub } from "../session";

/**
 * Name and phone inputs that suggest known customers while typing, so
 * regulars are booked in two keystrokes and stay linked to their history.
 */
export function CustomerFields({
  name,
  phone,
  onChange,
}: {
  name: string;
  phone: string;
  onChange: (name: string, phone: string) => void;
}) {
  const t = useT();
  const { club } = useClub();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.customers(club.id, q)
        .then((list) => !cancelled && setMatches(list.slice(0, 6)))
        .catch(() => !cancelled && setMatches([]));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [club.id, query]);

  const pick = (c: Customer) => {
    onChange(c.name, c.phone);
    setOpen(false);
    setQuery("");
  };

  const suggestions = open && matches.length > 0 && (
    <ul className="suggest" role="listbox">
      {matches.map((c) => (
        <li key={c.id}>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
            <strong>{c.name}</strong>
            <span dir="ltr">{c.phone}</span>
            <small>
              {t("customers.visitsCount", { count: c.visits })}
              {c.no_shows > 0 && ` · ${t("customers.noShowsCount", { count: c.no_shows })}`}
            </small>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <label className="field suggest-wrap">
        <span>{t("booking.customerName")}</span>
        <input
          value={name}
          onChange={(e) => {
            onChange(e.target.value, phone);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          required
          maxLength={120}
          autoComplete="off"
        />
        {query === name && suggestions}
      </label>
      <label className="field suggest-wrap">
        <span>{t("booking.phone")}</span>
        <input
          value={phone}
          onChange={(e) => {
            onChange(name, e.target.value);
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          maxLength={32}
          inputMode="tel"
          dir="ltr"
          autoComplete="off"
          placeholder={t("booking.phoneHint")}
        />
        {query === phone && query !== name && suggestions}
      </label>
    </>
  );
}
