import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Api, messageOf, type RevenueReport } from "../api";
import { addDays, compactNumber, daysBetween, money, shortDate, todayIn } from "../format";
import { useClub } from "../session";

type Range = { from: string; to: string };

function presets(today: string): [string, Range][] {
  const monthStart = `${today.slice(0, 8)}01`;
  return [
    ["Last 7 days", { from: addDays(today, -6), to: today }],
    ["This month", { from: monthStart, to: today }],
    ["Last 30 days", { from: addDays(today, -29), to: today }],
    ["Last 90 days", { from: addDays(today, -89), to: today }],
  ];
}

export default function Revenue() {
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
      .catch((e) => !cancelled && setError(messageOf(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [club.id, range, canManage]);

  // Every day in the range, including days without bookings.
  const days = useMemo(() => {
    if (!report) return [];
    const byDate = new Map(report.by_day.map((d) => [d.date, d]));
    const span = daysBetween(report.date_from, report.date_to);
    return Array.from({ length: span + 1 }, (_, i) => {
      const date = addDays(report.date_from, i);
      const row = byDate.get(date);
      return { date, total: row ? Number(row.total) : 0, bookings: row?.bookings ?? 0 };
    });
  }, [report]);

  if (!canManage) {
    return (
      <div className="page">
        <div className="card empty">
          <h3>Managers only</h3>
          <p className="muted">The revenue report is available to the club owner and managers.</p>
        </div>
      </div>
    );
  }

  const total = report ? Number(report.total) : 0;
  const best = days.reduce<(typeof days)[number] | null>((b, d) => (d.total > (b?.total ?? 0) ? d : b), null);
  const activePreset = options.find(([, r]) => r.from === range.from && r.to === range.to)?.[0];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Revenue</p>
          <h1>
            {shortDate(range.from)} – {shortDate(range.to)}
          </h1>
        </div>
      </header>

      <div className="filters">
        <div className="segmented">
          {options.map(([label, r]) => (
            <button key={label} className={activePreset === label ? "on" : ""} onClick={() => setRange(r)}>
              {label}
            </button>
          ))}
        </div>
        <label className="inline-field">
          From
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
          />
        </label>
        <label className="inline-field">
          To
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
          />
        </label>
      </div>

      {error && <div className="alert">{error}</div>}

      {report && (
        <div className={loading ? "is-loading" : ""}>
          <div className="stat-row">
            <div className="stat stat-hero">
              <span className="stat-label">Revenue</span>
              <strong className="stat-value">{money(total, report.currency)}</strong>
              <span className="stat-sub">confirmed bookings only</span>
            </div>
            <div className="stat">
              <span className="stat-label">Bookings</span>
              <strong className="stat-value">{report.bookings}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Average booking</span>
              <strong className="stat-value">
                {money(report.bookings ? total / report.bookings : 0, report.currency)}
              </strong>
            </div>
            <div className="stat">
              <span className="stat-label">Best day</span>
              <strong className="stat-value">{best ? shortDate(best.date) : "—"}</strong>
              {best && <span className="stat-sub">{money(best.total, report.currency)}</span>}
            </div>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Revenue by day</h2>
              <button className="link-btn" onClick={() => setShowTable((v) => !v)}>
                {showTable ? "Show chart" : "Show table"}
              </button>
            </div>
            {showTable ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="num">Bookings</th>
                      <th className="num">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>{shortDate(d.date)}</td>
                        <td className="num">{d.bookings}</td>
                        <td className="num strong">{money(d.total, report.currency)}</td>
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
              <h2>Revenue by court</h2>
            </div>
            {report.by_court.length === 0 ? (
              <p className="muted">No bookings in this period.</p>
            ) : (
              <div className="hbars">
                {report.by_court.map((c) => {
                  const value = Number(c.total);
                  const share = total ? value / total : 0;
                  const max = Math.max(...report.by_court.map((x) => Number(x.total)));
                  return (
                    <div key={c.court} className="hbar">
                      <span className="hbar-label">{c.court_name}</span>
                      <div className="hbar-track">
                        <span className="hbar-fill" style={{ width: `${(value / max) * 100}%` }} />
                      </div>
                      <span className="hbar-value">
                        <strong>{money(value, report.currency)}</strong>
                        <small>
                          {Math.round(share * 100)}% · {c.bookings} bookings
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

function niceMax(value: number) {
  if (value <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  return (steps.find((s) => s * magnitude >= value) ?? 10) * magnitude;
}

function DayChart({
  days,
  currency,
}: {
  days: { date: string; total: number; bookings: number }[];
  currency: string;
}) {
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

  const max = niceMax(Math.max(0, ...days.map((d) => d.total)));
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
    <div className="chart" ref={box} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={CHART_HEIGHT} role="img" aria-label="Revenue by day bar chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid-line" />
            <text x={PAD.left - 8} y={y(t)} className="axis-text" textAnchor="end" dominantBaseline="middle">
              {compactNumber(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.left + i * band + gap / 2;
          const h = Math.max(0, y(0) - y(d.total));
          const r = Math.min(4, barW / 2, h);
          const top = y(0) - h;
          return (
            <g key={d.date}>
              {h > 0 && (
                <path
                  className={`bar${hover === i ? " is-hover" : ""}`}
                  d={`M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${y(0)} Z`}
                />
              )}
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
                aria-label={`${shortDate(d.date)}: ${money(d.total, currency)}`}
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
            left: Math.min(Math.max(PAD.left + (hover + 0.5) * band, 70), width - 70),
            top: Math.max(y(hovered.total) - 12, 8),
          }}
        >
          <strong>{money(hovered.total, currency)}</strong>
          <span>
            {shortDate(hovered.date)} · {hovered.bookings} bookings
          </span>
        </div>
      )}
    </div>
  );
}
