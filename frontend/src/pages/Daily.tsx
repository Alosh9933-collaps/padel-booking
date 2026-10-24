import { useEffect, useState } from "react";

import { Api, type DailyReport, type PaymentMethod } from "../api";
import { BillModal, PaymentBadge } from "../components/Bill";
import { QuickSaleModal } from "../components/QuickSale";
import { SalesList } from "../components/SalesList";
import { ShiftHistory, ShiftPanel } from "../components/ShiftPanel";
import { addDays, longDate, minus, money, timeRange, todayIn } from "../format";
import { errorText, useT } from "../i18n";
import { useClub } from "../session";
import { useNow } from "./Schedule";

const METHODS: PaymentMethod[] = ["cash", "card", "transfer"];

/** End-of-day cash-up: what came in, what the buffet sold, which bills are still open. */
export default function Daily() {
  const t = useT();
  const { club, canManage } = useClub();
  const now = useNow();
  const [selling, setSelling] = useState(false);
  const today = todayIn(club.timezone);
  const [date, setDate] = useState(today);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bill, setBill] = useState<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Api.daily(club.id, date)
      .then((r) => {
        if (!cancelled) {
          setReport(r);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(errorText(e, t)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [club.id, date, version, t]);

  const byMethod = (m: PaymentMethod) => report?.by_method.find((r) => r.method === m);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.daily")}</p>
          <h1>{longDate(date)}</h1>
        </div>
        <div className="head-actions">
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))} aria-label={t("schedule.prevDay")}>
            <span className="flip">‹</span>
          </button>
          <button className="btn" onClick={() => setDate(today)} disabled={date === today}>
            {t("schedule.today")}
          </button>
          <input type="date" className="date-input" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label={t("schedule.date")} />
          <button className="btn" onClick={() => setDate(addDays(date, 1))} aria-label={t("schedule.nextDay")}>
            <span className="flip">›</span>
          </button>
        </div>
          <button className="btn btn-primary" onClick={() => setSelling(true)}>
            🛒 {t("sale.button")}
          </button>
        </div>
      </header>
      {error && <div className="alert">{error}</div>}
      {date === today && <ShiftPanel version={version} onChanged={() => setVersion((v) => v + 1)} />}

      {report && (
        <div className={loading ? "is-loading" : ""}>
          <div className="stat-row">
            <div className="stat stat-hero">
              <span className="stat-label">{t("daily.received")}</span>
              <strong className="stat-value">{money(report.received, report.currency)}</strong>
              <span className="stat-sub">{t("daily.receivedHint")}</span>
            </div>
            {METHODS.map((m) => (
              <div key={m} className="stat">
                <span className="stat-label">{t(`method.${m}`)}</span>
                <strong className="stat-value">{money(byMethod(m)?.total ?? 0, report.currency)}</strong>
                <span className="stat-sub">
                  {t("daily.methodBreakdown", {
                    bookings: money(byMethod(m)?.bookings ?? 0, report.currency),
                    sales: money(byMethod(m)?.sales ?? 0, report.currency),
                  })}
                  {Number(byMethod(m)?.topups ?? 0) > 0 && (
                    <span className="ok-text"> · {t("daily.topups")} {money(byMethod(m)?.topups ?? 0, report.currency)}</span>
                  )}
                  {Number(byMethod(m)?.refunds ?? 0) > 0 && (
                    <span className="due-text"> · {t("daily.refunds")} {minus(money(byMethod(m)?.refunds ?? 0, report.currency))}</span>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div className="settings-grid">
            <section className="card">
              <div className="card-head">
                <h2>{t("daily.unpaid")}</h2>
                {Number(report.unpaid_total) > 0 && <strong className="due-text">{money(report.unpaid_total, report.currency)}</strong>}
              </div>
              {report.unpaid.length === 0 ? (
                <p className="muted">✓ {t("daily.allPaid")}</p>
              ) : (
                report.unpaid.map((b) => (
                  <button key={b.id} className="history-row" onClick={() => setBill(b.id)}>
                    <span>
                      {b.customer_name}
                      <small>
                        {b.court_name} · {timeRange(b.start_at, b.end_at, club.timezone)}
                      </small>
                    </span>
                    <PaymentBadge booking={b} />
                    <strong>{money(b.balance, club.currency)}</strong>
                  </button>
                ))
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>{t("daily.buffet")}</h2>
                <strong>{money(report.buffet_total, report.currency)}</strong>
              </div>
              {report.buffet.length === 0 ? (
                <p className="muted">{t("daily.noBuffet")}</p>
              ) : (
                <table className="table">
                  <tbody>
                    {report.buffet.map((row) => (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td className="num">× {row.quantity}</td>
                        <td className="num strong">{money(row.total, report.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="hint">{t("daily.bookingsCount", { count: report.bookings })}</p>
              {Number(report.discount_total) > 0 && (
                <p className="hint">{t("daily.discounts", { amount: money(report.discount_total, report.currency) })}</p>
              )}
              {Number(report.balance_used) > 0 && (
                <p className="hint">{t("daily.balanceUsed", { amount: money(report.balance_used, report.currency) })}</p>
              )}
              {Number(report.refunds_total) > 0 && (
                <p className="hint">{t("daily.refundsGiven", { amount: money(report.refunds_total, report.currency) })}</p>
              )}
            </section>

            <SalesList date={date} version={version} onChanged={() => setVersion((v) => v + 1)} />
          </div>
          {canManage && <ShiftHistory version={version} />}
        </div>
      )}
      {selling && <QuickSaleModal onClose={() => setSelling(false)} onDone={() => setVersion((v) => v + 1)} />}

      {bill !== null && (
        <BillModal
          bookingId={bill}
          now={now}
          onClose={() => setBill(null)}
          onChanged={() => {
            setBill(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
