import { useState, type FormEvent } from "react";

import { Api, type StaffMember } from "../api";
import { errorText, useT } from "../i18n";
import { useToast } from "../session";
import { Modal } from "./Modal";

/** Owners and managers: a new password for a staff member who forgot theirs. */
export function SetStaffPasswordModal({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const t = useT();
  const notify = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.setStaffPassword(member.id, password);
      notify(t("password.setFor", { name: member.username }));
      onClose();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("password.setTitle", { name: member.username })}
      subtitle={t("password.setHint")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="staff-password" disabled={busy || !password}>
            {busy ? t("common.saving") : t("password.save")}
          </button>
        </>
      }
    >
      <form id="staff-password" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("password.new")}</span>
          {/* Shown as typed: the manager reads it out to the staff member. */}
          <input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" required />
        </label>
        <p className="hint">{t("password.rules")}</p>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}

/** Anyone: change your own password, after typing the current one. */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const notify = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setError(t("password.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await Api.changePassword(current, next);
      notify(t("password.changed"));
      onClose();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("password.changeTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="own-password" disabled={busy || !current || !next}>
            {busy ? t("common.saving") : t("password.save")}
          </button>
        </>
      }
    >
      <form id="own-password" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("password.current")}</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" dir="ltr" required />
        </label>
        <label className="field">
          <span>{t("password.new")}</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" dir="ltr" required />
        </label>
        <label className="field">
          <span>{t("password.repeat")}</span>
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" dir="ltr" required />
        </label>
        <p className="hint">{t("password.rules")}</p>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
