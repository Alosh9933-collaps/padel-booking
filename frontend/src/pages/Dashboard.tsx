import { useEffect, useMemo, useState } from "react";

import { Api, type Dashboard as DashboardData, type DashboardPeriod } from "../api";
import { CategoryBadge } from "./Customers";
import { compactMoney, hourLabel, money, shortDate, weekdayNames } from "../format";
import { errorText, useI18n, useT } from "../i18n";
import { useClub } from "../session";

// One hue, light to dark: how busy an hour is.
const RAMP = ["#f1f5fb", "#d6e6fa", "#a9cbf3", "#6fa6e8", "#3b82db", "#1d6fd1", "#1757a8"];

function rampColor(occupancy: number) {
  if (occupancy <= 0) return RAMP[0];
  return RAMP[Math.min(RAMP.length - 1, 1 + Math.floor((occupancy / 100) * (RAMP.length - 1)))];
}

/** "+12%" against last month, or null when there is nothing to compare with. */
function change(now: number, before: number) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}

export default function Dashboard() {
  const t = useT();
  const { club, canManage } = useClub();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    Api.dashboard(club.id)
      .then(setData)
      .catch((e) => setError(errorText(e, t)));
  }, [club.id, canManage, t]);

  if (!canManage) {
    return (
      <div className="page">
        <div className="card empty">
          <h3>{t("common.managersOnly")}</h3>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.dashboard")}</p>
          <h1>{club.name}</h1>
        </div>
        {data && (
          <p className="muted small">
            {t("dashboard.compared", {
              from: shortDate(data.this_month.from),
              to: shortDate(data.this_month.to),
              prevFrom: shortDate(data.last_month.from),
              prevTo: shortDate(data.last_month.to),
            })}
          </p>
        )}
      </header>
      {error && <div className="alert">{error}</div>}
      {data && (
        <>
          <Kpis now={data.this_month} before={data.last_month} currency={data.currency} />
          <div className="dash-grid">
            <Heatmap data={data} />
            <section className="card">
              <div className="card-head">
                <div>
                  <h2>{t("dashboard.months")}</h2>
                </div>
              </div>
              <Months months={data.months} currency={data.currency} />
            </section>
          </div>
          <TopCustomers data={data} />
        </>
      )}
    </div>
  );
}

function Kpis({ now, before, currency }: { now: DashboardPeriod; before: DashboardPeriod; currency: string }) {
  const t = useT();
  const tiles: { key: string; value: string; delta: number | null; hero?: boolean }[] = [
    { key: "dashboard.revenue", value: money(now.revenue, currency), delta: change(Number(now.revenue), Number(before.revenue)), hero: true },
    { key: "dashboard.bookings", value: String(now.bookings), delta: change(now.bookings, before.bookings) },
    { key: "dashboard.occupancy", value: `${now.occupancy}%`, delta: change(now.occupancy, before.occupancy) },
    { key: "dashboard.average", value: money(now.average, currency), delta: change(Number(now.average), Number(before.average)) },
    { key: "dashboard.newCustomers", value: String(now.new_customers), delta: change(now.new_customers, before.new_customers) },
    { key: "dashboard.topups", value: money(now.topups, currency), delta: change(Number(now.topups), Number(before.topups)) },
  ];
  return (
    <div className="stat-row">
      {tiles.map((tile) => (
        <div key={tile.key} className={`stat${tile.hero ? " stat-hero" : ""}`}>
          <span className="stat-label">{t(tile.key)}</span>
          <strong className="stat-value">{tile.value}</strong>
          <span className={`delta ${tile.delta === null ? "" : tile.delta >= 0 ? "up" : "down"}`}>
            {tile.delta === null ? t("dashboard.noCompare") : `${tile.delta >= 0 ? "▲" : "▼"} ${Math.abs(tile.delta)}% ${t("dashboard.vsLast")}`}
          </span>
        </div>
      ))}
    </div>
  );
}

function Heatmap({ data }: { data: DashboardData }) {
  const t = useT();
  const days = weekdayNames();
  const hours = useMemo(() => [...new Set(data.heatmap.cells.map((c) => c.hour))].sort((a, b) => a - b), [data]);
  const cell = (weekday: number, hour: number) =>
    data.heatmap.cells.find((c) => c.weekday === weekday && c.hour === hour)?.occupancy ?? 0;
  // The quietest hours on weekday evenings and weekends are where a discount helps most.
  const quiet = [...data.heatmap.cells].sort((a, b) => a.occupancy - b.occupancy).slice(0, 4);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{t("dashboard.heatmap")}</h2>
          <p className="muted">
            {t("dashboard.heatmapHint", { from: shortDate(data.heatmap.from), to: shortDate(data.heatmap.to) })}
          </p>
        </div>
      </div>
      <div className="table-wrap" dir="ltr">
        <div className="heatmap" style={{ gridTemplateColumns: `minmax(44px, auto) repeat(${hours.length}, minmax(30px, 1fr))` }}>
          <span />
          {hours.map((h) => (
            <span key={h} className="pm-hour">
              {String(h).padStart(2, "0")}
            </span>
          ))}
          {days.map((name, weekday) => (
            <div key={weekday} className="pm-row">
              <span className="pm-day">{name}</span>
              {hours.map((h) => {
                const value = cell(weekday, h);
                return (
                  <span
                    key={h}
                    className="hm-cell"
                    style={{ background: rampColor(value), color: value >= 50 ? "#fff" : "var(--ink-2)" }}
                    title={`${name} ${hourLabel(h)}: ${value}%`}
                  >
                    {value > 0 ? value : ""}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="legend">
        <span>{t("dashboard.quiet")}</span>
        {RAMP.map((c) => (
          <i key={c} className="sw" style={{ background: c }} />
        ))}
        <span>{t("dashboard.busy")}</span>
      </div>
      <p className="note quiet-note">
        💡 {t("dashboard.quietHours")}{" "}
        {quiet.map((c) => `${days[c.weekday]} ${hourLabel(c.hour)} (${c.occupancy}%)`).join(" · ")}
      </p>
    </section>
  );
}

function Months({ months, currency }: { months: DashboardData["months"]; currency: string }) {
  const { lang } = useI18n();
  const max = Math.max(1, ...months.map((m) => Number(m.revenue)));
  const label = (key: string) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleDateString(lang === "ar" ? "ar-u-nu-latn" : lang === "ru" ? "ru-RU" : "en-GB", {
      month: "short",
      timeZone: "UTC",
    });
  return (
    <div className="month-bars" dir="ltr">
      {months.map((m, i) => (
        <div key={m.month} className={`month-bar${i === months.length - 1 ? " is-now" : ""}`}>
          <span className="month-value" title={money(m.revenue, currency)}>
            {compactMoney(m.revenue, currency)}
          </span>
          <span className="month-track">
            <span style={{ height: `${(Number(m.revenue) / max) * 100}%` }} />
          </span>
          <span className="month-label">{label(m.month)}</span>
        </div>
      ))}
    </div>
  );
}

function TopCustomers({ data }: { data: DashboardData }) {
  const t = useT();
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{t("dashboard.topCustomers")}</h2>
          <p className="muted">{t("dashboard.topCustomersHint")}</p>
        </div>
      </div>
      {data.top_customers.length === 0 ? (
        <p className="muted">{t("customers.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("customers.name")}</th>
                <th>{t("customers.category")}</th>
                <th className="num">{t("customers.visits")}</th>
                <th className="num">{t("customers.spent")}</th>
              </tr>
            </thead>
            <tbody>
              {data.top_customers.map((c, i) => (
                <tr key={c.id}>
                  <td className="muted">{i + 1}</td>
                  <td className="strong">
                    {c.name}
                    <small className="muted phone top-phone" dir="ltr">
                      {c.phone}
                    </small>
                  </td>
                  <td>
                    <CategoryBadge name={c.category_name} color={c.category_color} />
                  </td>
                  <td className="num">{c.visits}</td>
                  <td className="num strong">{money(c.spent, data.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
