import { useEffect, useMemo, useState } from "react";

import { Api, type Activity } from "../api";
import { ActivityList } from "../components/ActivityList";
import { BillModal } from "../components/Bill";
import { addDays, longDate, money, todayIn } from "../format";
import { errorText, useT } from "../i18n";
import { useClub } from "../session";
import { useNow } from "./Schedule";

const GROUPS = ["", "booking", "discount", "payment", "refund", "item", "sale", "wallet", "shift"];

/** Who did what today: the club's activity log, for owners and managers. */
export default function ActivityLog() {
  const t = useT();
  const { club, canManage } = useClub();
  const now = useNow();
  const today = todayIn(club.timezone);
  const [date, setDate] = useState(today);
  const [group, setGroup] = useState("");
  const [user, setUser] = useState("");
  const [items, setItems] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bill, setBill] = useState<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    Api.activity({ club: club.id, date, action: group || undefined })
      .then((list) => {
        if (!cancelled) {
          setItems(list);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(errorText(e, t)));
    return () => {
      cancelled = true;
    };
  }, [club.id, date, group, version, canManage, t]);

  const users = useMemo(() => [...new Set((items ?? []).map((a) => a.user_name).filter(Boolean))].sort(), [items]);
  const shown = (items ?? []).filter((a) => !user || a.user_name === user);

  // Per person: how much discount they gave and how much they gave back today.
  const perUser = useMemo(() => {
    const totals = new Map<string, { discounts: number; refunds: number; removed: number }>();
    for (const a of items ?? []) {
      const key = a.user_name || "—";
      const row = totals.get(key) ?? { discounts: 0, refunds: 0, removed: 0 };
      if (a.action === "discount.applied") row.discounts += Number(a.amount ?? 0);
      if (a.action === "refund.added") row.refunds += Number(a.amount ?? 0);
      if (a.action === "payment.removed") row.removed += Number(a.amount ?? 0);
      totals.set(key, row);
    }
    return [...totals.entries()].filter(([, r]) => r.discounts || r.refunds || r.removed);
  }, [items]);

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
          <p className="eyebrow">{t("nav.activity")}</p>
          <h1>{longDate(date)}</h1>
        </div>
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))} aria-label={t("schedule.prevDay")}>
            ‹
          </button>
          <button className="btn" onClick={() => setDate(today)} disabled={date === today}>
            {t("schedule.today")}
          </button>
          <input type="date" className="date-input" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label={t("schedule.date")} />
          <button className="btn" onClick={() => setDate(addDays(date, 1))} aria-label={t("schedule.nextDay")}>
            ›
          </button>
        </div>
      </header>

      <div className="filters">
        <div className="cat-filter">
          {GROUPS.map((g) => (
            <button key={g || "all"} className={group === g ? "on" : ""} onClick={() => setGroup(g)}>
              {g ? t(`act.group.${g}`) : t("customers.all")}
            </button>
          ))}
        </div>
        {users.length > 1 && (
          <select value={user} onChange={(e) => setUser(e.target.value)} aria-label={t("activity.byUser")}>
            <option value="">{t("activity.everyone")}</option>
            {users.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="alert">{error}</div>}

      {perUser.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>{t("activity.watch")}</h2>
              <p className="muted">{t("activity.watchHint")}</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("staff.username")}</th>
                  <th className="num">{t("activity.discountsGiven")}</th>
                  <th className="num">{t("activity.refundsGiven")}</th>
                  <th className="num">{t("activity.paymentsRemoved")}</th>
                </tr>
              </thead>
              <tbody>
                {perUser.map(([name, r]) => (
                  <tr key={name}>
                    <td className="strong">{name}</td>
                    <td className="num">{r.discounts ? money(r.discounts, club.currency) : "—"}</td>
                    <td className="num">{r.refunds ? money(r.refunds, club.currency) : "—"}</td>
                    <td className="num">{r.removed ? money(r.removed, club.currency) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        {items === null && <p className="muted">{t("common.loading")}</p>}
        {items !== null && shown.length === 0 && <p className="muted">{t("activity.empty")}</p>}
        {shown.length > 0 && <ActivityList items={shown} onOpenBooking={setBill} />}
      </section>

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
