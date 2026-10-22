import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Api, type Court, type PriceRule, type PriceRuleInput } from "../api";
import { Modal } from "../components/Modal";
import { hourLabel, money, weekdayNames } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

// Sequential ramp (one hue, light to dark) for the weekly price map.
const RAMP = ["#e3eefc", "#bcd6f7", "#8fb9ef", "#5c97e2", "#2f76d4", "#1757a8"];

/** Same rule choice as the backend: highest priority, then court-specific over club-wide. */
function pickRule(rules: PriceRule[], courtId: number | null, day: number, hour: number) {
  let best: PriceRule | null = null;
  for (const r of rules) {
    if (r.court !== null && r.court !== courtId) continue;
    if (!r.days_of_week.includes(day) || hour < r.start_hour || hour >= r.end_hour) continue;
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.court !== null && best.court === null)) {
      best = r;
    }
  }
  return best;
}

export default function Prices() {
  const t = useT();
  const { club, canManage } = useClub();
  const [rules, setRules] = useState<PriceRule[] | null>(null);
  const [courts, setCourts] = useState<Court[]>([]);
  const [viewCourt, setViewCourt] = useState<number | null>(null);
  const [editing, setEditing] = useState<PriceRule | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const days = weekdayNames();

  const load = () =>
    Promise.all([Api.priceRules(club.id), Api.courts()])
      .then(([r, c]) => {
        const own = c.filter((court) => court.club === club.id);
        setRules(r);
        setCourts(own);
        // Show a real court by default: it includes both club-wide and court-specific rules.
        setViewCourt((current) => current ?? own[0]?.id ?? null);
      })
      .catch((e) => setError(errorText(e, t)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  const courtName = (id: number | null) =>
    id === null ? t("prices.allCourts") : courts.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.prices")}</p>
          <h1>{t("prices.title")}</h1>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            + {t("prices.add")}
          </button>
        )}
      </header>
      {!canManage && <p className="note">{t("prices.readOnly")}</p>}
      {error && <div className="alert">{error}</div>}

      {rules && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>{t("prices.week")}</h2>
              <p className="muted">{t("prices.weekHint")}</p>
            </div>
            <select
              value={viewCourt ?? ""}
              onChange={(e) => setViewCourt(e.target.value ? Number(e.target.value) : null)}
              aria-label={t("prices.showFor")}
            >
              <option value="">{t("prices.clubWideOnly")}</option>
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <PriceMap rules={rules} courtId={viewCourt} />
        </section>
      )}

      {rules && (
        <section className="card">
          <div className="card-head">
            <h2>{t("prices.rules")}</h2>
          </div>
          {rules.length === 0 ? (
            <p className="muted">{t("prices.empty")}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("prices.days")}</th>
                    <th>{t("prices.hours")}</th>
                    <th>{t("prices.court")}</th>
                    <th className="num">{t("prices.perHour")}</th>
                    <th className="num">{t("prices.priority")}</th>
                    {canManage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="day-chips">
                          {days.map((d, i) => (
                            <span key={d} className={r.days_of_week.includes(i) ? "on" : ""}>
                              {d}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td dir="ltr" className="phone">
                        {hourLabel(r.start_hour)}–{hourLabel(r.end_hour)}
                      </td>
                      <td>{courtName(r.court)}</td>
                      <td className="num strong">{money(r.price_per_hour, club.currency)}</td>
                      <td className="num">{r.priority}</td>
                      {canManage && (
                        <td className="num">
                          <button className="btn btn-small" onClick={() => setEditing(r)}>
                            {t("common.edit")}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {editing && (
        <RuleModal
          rule={editing === "new" ? null : editing}
          courts={courts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PriceMap({ rules, courtId }: { rules: PriceRule[]; courtId: number | null }) {
  const t = useT();
  const { club } = useClub();
  const days = weekdayNames();
  const hours = useMemo(() => {
    const list = [];
    for (let h = club.opening_hour; h < club.closing_hour; h++) list.push(h);
    return list;
  }, [club.opening_hour, club.closing_hour]);

  const grid = days.map((_, day) => hours.map((h) => pickRule(rules, courtId, day, h)));
  const prices = [
    ...new Set(grid.flat().filter((r): r is PriceRule => r !== null).map((r) => Number(r.price_per_hour))),
  ].sort((a, b) => a - b);

  const colorOf = (price: number) => {
    if (prices.length === 1) return RAMP[3];
    const step = prices.indexOf(price) / (prices.length - 1);
    return RAMP[Math.round(step * (RAMP.length - 1))];
  };

  return (
    <>
      <div className="table-wrap" dir="ltr">
        <div className="price-map" style={{ gridTemplateColumns: `minmax(44px, auto) repeat(${hours.length}, minmax(44px, 1fr))` }}>
          <span />
          {hours.map((h) => (
            <span key={h} className="pm-hour">
              {String(h).padStart(2, "0")}
            </span>
          ))}
          {grid.map((row, day) => (
            <div key={day} className="pm-row">
              <span className="pm-day">{days[day]}</span>
              {row.map((rule, i) => {
                if (!rule) return <span key={i} className="pm-cell pm-empty" title={t("prices.noPrice")} />;
                const price = Number(rule.price_per_hour);
                const index = RAMP.indexOf(colorOf(price));
                return (
                  <span
                    key={i}
                    className="pm-cell"
                    style={{ background: colorOf(price), color: index >= 3 ? "#fff" : "var(--ink)" }}
                    title={`${days[day]} ${hourLabel(hours[i])}: ${money(price, club.currency)}`}
                  >
                    {price >= 1000 ? `${+(price / 1000).toFixed(1)}k` : price}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {prices.length > 0 && (
        <div className="legend">
          {prices.map((p) => (
            <span key={p}>
              <i className="sw" style={{ background: colorOf(p) }} /> {money(p, club.currency)} / {t("prices.hourShort")}
            </span>
          ))}
          <span>
            <i className="sw sw-closed" /> {t("prices.noPrice")}
          </span>
        </div>
      )}
    </>
  );
}

const PRESETS: [string, number[]][] = [
  ["prices.weekdays", [0, 1, 2, 3, 4]],
  ["prices.weekend", [5, 6]],
  ["prices.everyDay", [0, 1, 2, 3, 4, 5, 6]],
];

function RuleModal({
  rule,
  courts,
  onClose,
  onSaved,
}: {
  rule: PriceRule | null;
  courts: Court[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const days = weekdayNames();
  const [selected, setSelected] = useState<number[]>(rule?.days_of_week ?? [0, 1, 2, 3, 4]);
  const [start, setStart] = useState(rule?.start_hour ?? club.opening_hour);
  const [end, setEnd] = useState(rule?.end_hour ?? club.closing_hour);
  const [court, setCourt] = useState<number | null>(rule?.court ?? null);
  const [price, setPrice] = useState(rule ? String(Number(rule.price_per_hour)) : "");
  const [priority, setPriority] = useState(rule?.priority ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleDay = (d: number) =>
    setSelected((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d].sort()));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) {
      setError(t("prices.pickDay"));
      return;
    }
    setBusy(true);
    setError(null);
    const body: PriceRuleInput = {
      club: club.id,
      court,
      days_of_week: selected,
      start_hour: start,
      end_hour: end,
      price_per_hour: price,
      priority,
    };
    try {
      if (rule) await Api.updatePriceRule(rule.id, body);
      else await Api.createPriceRule(body);
      notify(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    setBusy(true);
    try {
      await Api.deletePriceRule(rule.id);
      notify(t("prices.deleted"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  const hours = Array.from({ length: 25 }, (_, h) => h);

  return (
    <Modal
      title={rule ? t("prices.editRule") : t("prices.newRule")}
      subtitle={t("prices.keepHint")}
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <span className="muted grow">{t("prices.confirmDelete")}</span>
            <button className="btn" onClick={() => setConfirmDelete(false)} disabled={busy}>
              {t("common.keep")}
            </button>
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              {t("common.delete")}
            </button>
          </>
        ) : (
          <>
            {rule && (
              <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                {t("common.delete")}
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>
              {t("common.close")}
            </button>
            <button className="btn btn-primary" form="rule-form" disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
          </>
        )
      }
    >
      <form id="rule-form" className="form" onSubmit={submit}>
        <div className="field">
          <span>{t("prices.days")}</span>
          <div className="day-picker">
            {days.map((d, i) => (
              <button
                type="button"
                key={d}
                className={selected.includes(i) ? "on" : ""}
                onClick={() => toggleDay(i)}
                aria-pressed={selected.includes(i)}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="presets">
            {PRESETS.map(([label, value]) => (
              <button type="button" key={label} className="link-btn" onClick={() => setSelected(value)}>
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        <div className="field-row">
          <label className="field">
            <span>{t("booking.from")}</span>
            <select value={start} onChange={(e) => setStart(Number(e.target.value))}>
              {hours.slice(0, 24).map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("booking.until")}</span>
            <select value={end} onChange={(e) => setEnd(Number(e.target.value))}>
              {hours.slice(1).map((h) => (
                <option key={h} value={h}>
                  {h === 24 ? t("settings.midnight") : hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>{t("prices.pricePerHour", { currency: club.currency })}</span>
            <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </label>
          <label className="field">
            <span>{t("prices.priority")}</span>
            <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          </label>
        </div>
        <label className="field">
          <span>{t("prices.appliesTo")}</span>
          <select value={court ?? ""} onChange={(e) => setCourt(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("prices.allCourts")}</option>
            {courts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">{t("prices.priorityHint")}</p>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
