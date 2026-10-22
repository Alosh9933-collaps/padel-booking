import { useMemo, useState, type FormEvent } from "react";

import { Api } from "../api";
import { hourLabel } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

export default function Settings() {
  const t = useT();
  const { club, canManage, replaceClub } = useClub();
  const notify = useToast();
  const [opening, setOpening] = useState(club.opening_hour);
  const [closing, setClosing] = useState(club.closing_hour);
  const [timezone, setTimezone] = useState(club.timezone);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zones = useMemo(() => {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes(club.timezone) ? list : [club.timezone, ...list];
  }, [club.timezone]);

  const dirty = opening !== club.opening_hour || closing !== club.closing_hour || timezone !== club.timezone;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await Api.updateClub(club.id, { opening_hour: opening, closing_hour: closing, timezone });
      replaceClub(updated);
      notify(t("common.saved"));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const hours = Array.from({ length: 25 }, (_, h) => h);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.settings")}</p>
          <h1>{club.name}</h1>
        </div>
      </header>

      <div className="settings-grid">
        <section className="card">
          <div className="card-head">
            <h2>{t("settings.hours")}</h2>
          </div>
          <div className="hours-bar" aria-hidden dir="ltr">
            <span
              style={{
                left: `${(opening / 24) * 100}%`,
                width: `${(Math.max(0, closing - opening) / 24) * 100}%`,
              }}
            />
            {[0, 6, 12, 18, 24].map((h) => (
              <i key={h} style={{ left: `${(h / 24) * 100}%` }}>
                {h}
              </i>
            ))}
          </div>
          <form className="form" onSubmit={submit}>
            <div className="field-row">
              <label className="field">
                <span>{t("settings.opens")}</span>
                <select value={opening} disabled={!canManage} onChange={(e) => setOpening(Number(e.target.value))}>
                  {hours.slice(0, 24).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("settings.closes")}</span>
                <select value={closing} disabled={!canManage} onChange={(e) => setClosing(Number(e.target.value))}>
                  {hours.slice(1).map((h) => (
                    <option key={h} value={h}>
                      {h === 24 ? t("settings.midnight") : hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>{t("settings.timezone")}</span>
              <select value={timezone} disabled={!canManage} onChange={(e) => setTimezone(e.target.value)} dir="ltr">
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            {error && <div className="alert">{error}</div>}
            {canManage ? (
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || busy}>
                  {busy ? t("common.saving") : t("settings.save")}
                </button>
              </div>
            ) : (
              <p className="note">{t("settings.readOnly")}</p>
            )}
          </form>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>{t("settings.about")}</h2>
          </div>
          <dl className="details">
            <dt>{t("settings.yourRole")}</dt>
            <dd>
              <span className={`role role-${club.role}`}>{t(`role.${club.role}`)}</span>
            </dd>
            <dt>{t("settings.currency")}</dt>
            <dd>{club.currency}</dd>
            <dt>{t("settings.rows")}</dt>
            <dd>{t("settings.rowsValue", { minutes: club.slot_minutes })}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
