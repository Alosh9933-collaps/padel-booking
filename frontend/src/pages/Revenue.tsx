import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Api, type RevenueReport } from "../api";
import { addDays, compactNumber, daysBetween, minus, money, shortDate, todayIn } from "../format";
import { errorText, useT } from "../i18n";
import { useClub } from "../session";

type Range = { from: string; to: string };
type Day = { date: string; court: number; buffet: number; discounts: number; bookings: number };

function presets(today: string): [string, Range][] {
  const monthStart = `${today.slice(0, 8)}01`;
  return [
    ["revenue.last7", { from: addDays(today, -6), to: today }],
    ["revenue.thisMonth", { from: monthStart, to: today }],
    ["revenue.last30", { from: addDays(today, -29), to: today }],
    ["revenue.last90", { from: addDays(today, -89), to: today }],
  ];
}

export default function Revenue() {
  const t = useT();
  const { club, canManage } = useClub();
  const today = todayIn(club.timezone);
  const options = presets(today);
  const [range, setRange] = useState<Range>(options[0][1]);
  const [report, setReport] = useState<RevenueReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    if (!canManage || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    Api.revenue(club.id, range.from, range.to)
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
  }, [club.id, range, canManage, t]);

  // Every day in the range, including days without bookings.
  const days = useMemo<Day[]>(() => {
    if (!report) return [];
    const byDate = new Map(report.by_day.map((d) => [d.date, d]));
    const span = daysBetween(report.date_from, report.date_to);
    return Array.from({ length: span + 1 }, (_, i) => {
      const date = addDays(report.date_from, i);
      const row = byDate.get(date);
      return {
        date,
        court: row ? Number(row.total) : 0,
        buffet: row ? Number(row.buffet) : 0,
        discounts: row ? Number(row.discounts) : 0,
        bookings: row?.bookings ?? 0,
      };
    });
  }, [report]);

  if (!canManage) {
    return (
      <div className="page">
        <div className="card empty">
          <h3>{t("common.managersOnly")}</h3>
          <p className="muted">{t("revenue.managersHint")}</p>
        </div>
      </div>
    );
  }

  const grand = report ? Number(report.grand_total) : 0;
  const best = days.reduce<Day | null>((b, d) => (d.court + d.buffet > (b ? b.court + b.buffet : 0) ? d : b), null);
  const activePreset = options.find(([, r]) => r.from === range.from && r.to === range.to)?.[0];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.revenue")}</p>
          <h1>
            {shortDate(range.from)} – {shortDate(range.to)}
          </h1>
        </div>
      </header>

      <div className="filters">
        <div className="segmented">
          {options.map(([label, r]) => (
            <button key={label} className={activePreset === label ? "on" : ""} onClick={() => setRange(r)}>
              {t(label)}
            </button>
          ))}
        </div>
        <label className="inline-field">
          {t("revenue.from")}
          <input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
        </label>
        <label className="inline-field">
          {t("revenue.to")}
          <input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
        </label>
      </div>

      {error && <div className="alert">{error}</div>}

      {report && (
        <div className={loading ? "is-loading" : ""}>
          <div className="stat-row">
            <div className="stat stat-hero">
              <span className="stat-label">{t("revenue.total")}</span>
              <strong className="stat-value">{money(grand, report.currency)}</strong>
              <span className="stat-sub">{t("revenue.totalHint")}</span>
            </div>
            <div className="stat">
              <span className="stat-label">
                <i className="sw sw-court" /> {t("revenue.courts")}
              </span>
              <strong className="stat-value">{money(report.total, report.currency)}</strong>
              <span className="stat-sub">{t("revenue.bookingsCount", { count: report.bookings })}</span>
            </div>
            <div className="stat">
              <span className="stat-label">
                <i className="sw sw-buffet" /> {t("revenue.buffet")}
              </span>
              <strong className="stat-value">{money(report.buffet_total, report.currency)}</strong>
              <span className="stat-sub">{grand ? Math.round((Number(report.buffet_total) / grand) * 100) : 0}%</span>
            </div>
            <div className="stat">
              <span className="stat-label">{t("revenue.discounts")}</span>
              <strong className="stat-value">
                {Number(report.discount_total) > 0 ? minus(money(report.discount_total, report.currency)) : money(0, report.currency)}
              </strong>
              <span className="stat-sub">{t("revenue.discountsHint")}</span>
            </div>
            <div className="stat">
              <span className="stat-label">{t("revenue.bestDay")}</span>
              <strong className="stat-value">{best ? shortDate(best.date) : "—"}</strong>
              {best && <span className="stat-sub">{money(best.court + best.buffet, report.currency)}</span>}
            </div>
          </div>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>{t("revenue.byDay")}</h2>
                <div className="legend chart-legend">
                  <span><i className="sw sw-court" /> {t("revenue.courts")}</span>
                  <span><i className="sw sw-buffet" /> {t("revenue.buffet")}</span>
                </div>
              </div>
              <button className="link-btn" onClick={() => setShowTable((v) => !v)}>
                {showTable ? t("revenue.showChart") : t("revenue.showTable")}
              </button>
            </div>
            {showTable ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t("revenue.date")}</th>
                      <th className="num">{t("revenue.bookings")}</th>
                      <th className="num">{t("revenue.courts")}</th>
                      <th className="num">{t("revenue.buffet")}</th>
                      <th className="num">{t("revenue.discounts")}</th>
                      <th className="num">{t("revenue.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{shortDate(d.date)}</td>
                        <td className="num">{d.bookings}</td>
                        <td className="num">{money(d.court, report.currency)}</td>
                        <td className="num">{money(d.buffet, report.currency)}</td>
                        <td className="num">{d.discounts ? minus(money(d.discounts, report.currency)) : "—"}</td>
                        <td className="num strong">{money(d.court + d.buffet - d.discounts, report.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <DayChart days={days} currency={report.currency} />
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{t("revenue.byCourt")}</h2>
            </div>
            {report.by_court.length === 0 ? (
              <p className="muted">{t("revenue.noBookings")}</p>
            ) : (
              <div className="hbars">
                {report.by_court.map((c) => {
                  const value = Number(c.total);
                  const courtsTotal = Number(report.total);
                  const max = Math.max(...report.by_court.map((x) => Number(x.total)));
                  return (
                    <div key={c.court} className="hbar">
                      <span className="hbar-label">{c.court_name}</span>
                      <div className="hbar-track">
                        <span className="hbar-fill" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
                      </div>
                      <span className="hbar-value">
                        <strong>{money(value, report.currency)}</strong>
                        <small>
                          {courtsTotal ? Math.round((value / courtsTotal) * 100) : 0}% · {t("revenue.bookingsCount", { count: c.bookings })}
                        </small>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

const CHART_HEIGHT = 240;
const PAD = { top: 16, right: 8, bottom: 28, left: 52 };
const GAP = 2; // surface gap between stacked segments

function niceMax(value: number) {
  if (value <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  return (steps.find((s) => s * magnitude >= value) ?? 10) * magnitude;
}

/** Path of a bar segment, rounded only on its top end. */
function segment(x: number, w: number, top: number, bottom: number, round: boolean) {
  const h = bottom - top;
  if (h <= 0) return "";
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${bottom} Z`;
}

function DayChart({ days, currency }: { days: Day[]; currency: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const max = niceMax(Math.max(0, ...days.map((d) => d.court + d.buffet)));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const band = days.length ? plotW / days.length : 0;
  const gap = Math.min(8, Math.max(2, band * 0.25));
  const barW = Math.max(1, band - gap);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 56)));
  const hovered = hover !== null ? days[hover] : null;

  return (
    <div className="chart" ref={box} onPointerLeave={() => setHover(null)} dir="ltr">
      <svg width={width} height={CHART_HEIGHT} role="img" aria-label={t("revenue.byDay")}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className="grid-line" />
            <text x={PAD.left - 8} y={y(tick)} className="axis-text" textAnchor="end" dominantBaseline="middle">
              {compactNumber(tick)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.left + i * band + gap / 2;
          const base = y(0);
          const courtTop = y(d.court);
          const buffetTop = y(d.court + d.buffet);
          const hasBuffet = d.buffet > 0 && courtTop - buffetTop > GAP;
          return (
            <g key={d.date} className={hover === i ? "is-hover" : ""}>
              <path className="bar bar-court" d={segment(x, barW, courtTop, base, !hasBuffet)} />
              {hasBuffet && <path className="bar bar-buffet" d={segment(x, barW, buffetTop, courtTop - GAP, true)} />}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${shortDate(d.date)}: ${money(d.court + d.buffet, currency)}`}
              />
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={CHART_HEIGHT - 8} className="axis-text" textAnchor="middle">
                  {shortDate(d.date)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} className="base-line" />
      </svg>
      {hovered && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(PAD.left + (hover + 0.5) * band, 90), width - 90),
            top: Math.max(y(hovered.court + hovered.buffet) - 12, 8),
          }}
        >
          <strong>{money(hovered.court + hovered.buffet - hovered.discounts, currency)}</strong>
          <span className="tip-row">
            <i className="tip-key tip-court" /> {t("revenue.courts")} {money(hovered.court, currency)}
          </span>
          <span className="tip-row">
            <i className="tip-key tip-buffet" /> {t("revenue.buffet")} {money(hovered.buffet, currency)}
          </span>
          {hovered.discounts > 0 && (
            <span className="tip-row">
              {t("revenue.discounts")} {minus(money(hovered.discounts, currency))}
            </span>
          )}
          <span>
            {shortDate(hovered.date)} · {t("revenue.bookingsCount", { count: hovered.bookings })}
          </span>
        </div>
      )}
    </div>
  );
}
