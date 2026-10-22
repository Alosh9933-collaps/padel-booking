import { useMemo, useState, type FormEvent } from "react";

import { Api, messageOf } from "../api";
import { ROLE_LABEL, hourLabel } from "../format";
import { useClub, useToast } from "../session";

export default function Settings() {
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

  const dirty =
    opening !== club.opening_hour || closing !== club.closing_hour || timezone !== club.timezone;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await Api.updateClub(club.id, {
        opening_hour: opening,
        closing_hour: closing,
        timezone,
      });
      replaceClub(updated);
      notify("Club settings saved");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const hours = Array.from({ length: 25 }, (_, h) => h);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Club settings</p>
          <h1>{club.name}</h1>
        </div>
      </header>

      <div className="settings-grid">
        <section className="card">
          <div className="card-head">
            <h2>Opening hours</h2>
          </div>
          <div className="hours-bar" aria-hidden>
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
                <span>Opens</span>
                <select value={opening} disabled={!canManage} onChange={(e) => setOpening(Number(e.target.value))}>
                  {hours.slice(0, 24).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Closes</span>
                <select value={closing} disabled={!canManage} onChange={(e) => setClosing(Number(e.target.value))}>
                  {hours.slice(1).map((h) => (
                    <option key={h} value={h}>
                      {h === 24 ? "24:00 (midnight)" : hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Timezone</span>
              <select value={timezone} disabled={!canManage} onChange={(e) => setTimezone(e.target.value)}>
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
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            ) : (
              <p className="note">Only the owner or a manager can change these settings.</p>
            )}
          </form>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>About this club</h2>
          </div>
          <dl className="details">
            <dt>Your role</dt>
            <dd>
              <span className={`role role-${club.role}`}>{ROLE_LABEL[club.role]}</span>
            </dd>
            <dt>Currency</dt>
            <dd>{club.currency}</dd>
            <dt>Schedule rows</dt>
            <dd>every {club.slot_minutes} minutes (bookings can start at any minute)</dd>
          </dl>
          <p className="hint">
            Staff accounts are managed in the Django admin for now
            (<code>http://127.0.0.1:8000/admin/</code> → Memberships).
          </p>
        </section>
      </div>
    </div>
  );
}
