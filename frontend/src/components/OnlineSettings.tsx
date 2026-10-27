import { useState, type FormEvent } from "react";

import { Api, type Club } from "../api";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import { QrModal } from "./QrCode";

/** Owners and managers: the public booking page and Telegram alerts. */
export function OnlineSettings() {
  const t = useT();
  const { club, canManage, replaceClub } = useClub();
  const notify = useToast();
  const [enabled, setEnabled] = useState(club.online_booking_enabled);
  const [slug, setSlug] = useState(club.slug);
  const [daysAhead, setDaysAhead] = useState(club.online_days_ahead);
  const [cancelHours, setCancelHours] = useState(club.online_cancel_hours);
  const [prepay, setPrepay] = useState(club.online_prepay_percent);
  const [chatId, setChatId] = useState(club.telegram_chat_id);
  const [language, setLanguage] = useState<Club["language"]>(club.language);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link = `${window.location.origin}/book/${club.slug}`;
  const dirty =
    enabled !== club.online_booking_enabled ||
    slug !== club.slug ||
    daysAhead !== club.online_days_ahead ||
    cancelHours !== club.online_cancel_hours ||
    prepay !== club.online_prepay_percent ||
    chatId !== club.telegram_chat_id ||
    language !== club.language;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await Api.updateClub(club.id, {
        online_booking_enabled: enabled,
        slug: slug.trim().toLowerCase(),
        online_days_ahead: daysAhead,
        online_cancel_hours: cancelHours,
        online_prepay_percent: prepay,
        telegram_chat_id: chatId.trim(),
        language,
      });
      replaceClub(updated);
      notify(t("common.saved"));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="card settings-wide">
      <div className="card-head">
        <div>
          <h2>🌐 {t("online.title")}</h2>
          <p className="muted">{t("online.hint")}</p>
        </div>
      </div>
      <form className="form" onSubmit={submit}>
        <label className="switch">
          <input type="checkbox" checked={enabled} disabled={!canManage} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>
            {t("online.enable")}
            <small className="muted">{t("online.enableHint")}</small>
          </span>
        </label>
        {club.online_booking_enabled && (
          <div className="public-link">
            <code dir="ltr">{link}</code>
            <button type="button" className="btn btn-small" onClick={copy}>
              {copied ? `✓ ${t("receipt.copied")}` : t("receipt.copy")}
            </button>
            <a className="btn btn-small" href={link} target="_blank" rel="noreferrer">
              {t("online.open")} ↗
            </a>
            <button type="button" className="btn btn-small btn-primary" onClick={() => setShowQr(true)}>
              ▦ {t("qr.button")}
            </button>
          </div>
        )}
        <label className="field">
          <span>{t("online.address")}</span>
          <div className="prefixed" dir="ltr">
            <em>/book/</em>
            <input value={slug} disabled={!canManage} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9-]+" maxLength={60} required />
          </div>
        </label>
        <div className="field-row">
          <label className="field">
            <span>{t("online.daysAhead")}</span>
            <input type="number" min={1} max={90} value={daysAhead} disabled={!canManage} onChange={(e) => setDaysAhead(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>{t("online.cancelHours")}</span>
            <input type="number" min={0} max={168} value={cancelHours} disabled={!canManage} onChange={(e) => setCancelHours(Number(e.target.value))} />
          </label>
        </div>

        <h3 className="sub-head">💳 {t("prepay.title")}</h3>
        <p className="hint">{t("prepay.hint")}</p>
        <div className="field-row">
          <label className="field">
            <span>{t("prepay.percent")}</span>
            <div className="suffixed" dir="ltr">
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={prepay}
                disabled={!canManage}
                onChange={(e) => setPrepay(Math.max(0, Math.min(100, Number(e.target.value))))}
              />
              <em>%</em>
            </div>
          </label>
          <div className={`provider-state provider-${club.payments_provider ?? "none"}`}>
            <strong>{t(`prepay.provider.${club.payments_provider ?? "none"}`)}</strong>
            <small>{t(`prepay.providerHint.${club.payments_provider ?? "none"}`)}</small>
          </div>
        </div>
        {prepay === 0 && <p className="note">{t("prepay.offWarning")}</p>}

        <h3 className="sub-head">✈ {t("telegram.title")}</h3>
        <p className="hint">{t("telegram.hint")}</p>
        <div className="field-row">
          <label className="field">
            <span>{t("telegram.chatId")}</span>
            <input value={chatId} disabled={!canManage} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" dir="ltr" />
          </label>
          <label className="field">
            <span>{t("telegram.language")}</span>
            <select value={language} disabled={!canManage} onChange={(e) => setLanguage(e.target.value as Club["language"])}>
              <option value="ru">Русский</option>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        {error && <div className="alert">{error}</div>}
        {canManage && (
          <div className="form-actions">
            <button className="btn btn-primary" disabled={!dirty || busy}>
              {busy ? t("common.saving") : t("settings.save")}
            </button>
          </div>
        )}
      </form>
      {showQr && <QrModal link={link} onClose={() => setShowQr(false)} />}
    </section>
  );
}
