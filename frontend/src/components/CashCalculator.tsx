import { useMemo } from "react";

import { money } from "../format";
import { useT } from "../i18n";
import { useClub } from "../session";

/** Cash handed over by the customer, and the change to give back. */
export function CashCalculator({
  due,
  received,
  onChange,
}: {
  due: number;
  received: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const { club } = useClub();
  const handed = Number(received) || 0;
  const change = handed - due;
  // The exact amount, then the next round notes above it.
  const notes = useMemo(() => {
    const values = new Set<number>([due]);
    for (const step of [100, 500, 1000, 5000]) values.add(Math.ceil(due / step) * step);
    return [...values].filter((v) => v > 0).sort((a, b) => a - b).slice(0, 5);
  }, [due]);

  if (!(due > 0)) return null;

  return (
    <div className="cash-box">
      <label className="field">
        <span>{t("cash.received")}</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={received}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("cash.receivedHint")}
        />
      </label>
      <div className="quick">
        {notes.map((v) => (
          <button type="button" key={v} className={handed === v ? "on" : ""} onClick={() => onChange(String(v))}>
            {v === due ? t("cash.exact") : money(v, club.currency)}
          </button>
        ))}
      </div>
      {received !== "" &&
        (change >= 0 ? (
          <div className="change change-ok">
            <span>{t("cash.change")}</span>
            <strong>{money(change, club.currency)}</strong>
          </div>
        ) : (
          <div className="change change-short">
            <span>{t("cash.short")}</span>
            <strong>{money(-change, club.currency)}</strong>
          </div>
        ))}
    </div>
  );
}
