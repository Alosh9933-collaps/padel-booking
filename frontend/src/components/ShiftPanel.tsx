import { useEffect, useState, type FormEvent } from "react";

import { Api, type Shift } from "../api";
import { dateTime, minus, money } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import { Modal } from "./Modal";

/** The cash drawer: open a shift with the float, close it by counting the cash. */
export function ShiftPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [shift, setShift] = useState<Shift | null | undefined>(undefined);
  const [opening, setOpening] = useState("");
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Api.currentShift(club.id)
      .then(setShift)
      .catch((e) => setError(errorText(e, t)));
  }, [club.id, version, t]);

  const open = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setShift(await Api.openShift(club.id, opening || "0"));
      notify(t("shift.opened"));
      onChanged();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  if (shift === undefined) return null;

  if (shift === null) {
    return (
      <section className="shift shift-closed">
        <div>
          <strong>🔐 {t("shift.none")}</strong>
          <span className="muted small">{t("shift.noneHint")}</span>
        </div>
        <form className="shift-open" onSubmit={open}>
          <label className="inline-field">
            {t("shift.float")}
            <input type="number" min="0" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {t("shift.open")}
          </button>
        </form>
        {error && <div className="alert">{error}</div>}
      </section>
    );
  }

  return (
    <section className="shift shift-open-now">
      <div className="shift-head">
        <span className="live-badge">
          <span className="live-dot" aria-hidden /> {t("shift.isOpen")}
        </span>
        <span className="muted small">
          {t("shift.openedBy", { name: shift.opened_by_name || "—", time: dateTime(shift.opened_at, club.timezone) })}
        </span>
      </div>
      <div className="shift-math">
        <span>
          <small>{t("shift.float")}</small>
          {money(shift.opening_cash, club.currency)}
        </span>
        <b>+</b>
        <span>
          <small>{t("shift.cashBookings")}</small>
          {money(shift.cash_bookings, club.currency)}
        </span>
        <b>+</b>
        <span>
          <small>{t("shift.cashSales")}</small>
          {money(shift.cash_sales, club.currency)}
        </span>
        <b>−</b>
        <span>
          <small>{t("shift.cashRefunds")}</small>
          {money(shift.cash_refunds, club.currency)}
        </span>
        <b>=</b>
        <span className="shift-expected">
          <small>{t("shift.expected")}</small>
          {money(shift.expected, club.currency)}
        </span>
      </div>
      <button className="btn btn-primary" onClick={() => setClosing(true)}>
        {t("shift.close")}
      </button>
      {error && <div className="alert">{error}</div>}
      {closing && (
        <CloseShiftModal
          shift={shift}
          onClose={() => setClosing(false)}
          onClosed={() => {
            setClosing(false);
            setShift(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function CloseShiftModal({ shift, onClose, onClosed }: { shift: Shift; onClose: () => void; onClosed: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const difference = counted === "" ? null : Number(counted) - Number(shift.expected);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const closed = await Api.closeShift(shift.id, counted, note.trim());
      const diff = Number(closed.difference);
      notify(diff === 0 ? t("shift.closedExact") : t("shift.closedDiff", { amount: money(diff, club.currency) }));
      onClosed();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("shift.closeTitle")}
      subtitle={t("shift.expectedNow", { amount: money(shift.expected, club.currency) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="close-shift" disabled={busy || counted === ""}>
            {busy ? t("common.saving") : t("shift.close")}
          </button>
        </>
      }
    >
      <form id="close-shift" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("shift.counted")}</span>
          <input type="number" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} required />
          <small className="muted">{t("shift.countedHint")}</small>
        </label>
        {difference !== null && (
          <div className={`change ${difference === 0 ? "change-ok" : difference < 0 ? "change-short" : "change-extra"}`}>
            <span>{difference === 0 ? t("shift.exact") : difference < 0 ? t("shift.missing") : t("shift.extra")}</span>
            <strong>{difference < 0 ? minus(money(-difference, club.currency)) : money(difference, club.currency)}</strong>
          </div>
        )}
        <label className="field">
          <span>{t("shift.note")}</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("shift.noteHint")} />
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}

/** Past shifts and their differences, for owners and managers. */
export function ShiftHistory({ version }: { version: number }) {
  const t = useT();
  const { club } = useClub();
  const [shifts, setShifts] = useState<Shift[] | null>(null);

  useEffect(() => {
    Api.shifts(club.id)
      .then(setShifts)
      .catch(() => setShifts([]));
  }, [club.id, version]);

  const closed = (shifts ?? []).filter((s) => s.closed_at);
  if (closed.length === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>{t("shift.history")}</h2>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("shift.period")}</th>
              <th>{t("shift.people")}</th>
              <th className="num">{t("shift.expected")}</th>
              <th className="num">{t("shift.counted")}</th>
              <th className="num">{t("shift.difference")}</th>
            </tr>
          </thead>
          <tbody>
            {closed.map((s) => {
              const diff = Number(s.difference);
              return (
                <tr key={s.id} title={s.note || undefined}>
                  <td>
                    {dateTime(s.opened_at, club.timezone)} – {dateTime(s.closed_at as string, club.timezone)}
                  </td>
                  <td>
                    {s.opened_by_name}
                    {s.closed_by_name && s.closed_by_name !== s.opened_by_name && ` → ${s.closed_by_name}`}
                    {s.note && " 📝"}
                  </td>
                  <td className="num">{money(s.expected, club.currency)}</td>
                  <td className="num">{money(s.counted_cash ?? 0, club.currency)}</td>
                  <td className={`num strong ${diff < 0 ? "due-text" : diff > 0 ? "extra-text" : ""}`}>
                    {diff === 0 ? "✓" : diff < 0 ? minus(money(-diff, club.currency)) : `+${money(diff, club.currency)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
