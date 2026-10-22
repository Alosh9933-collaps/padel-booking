import { useEffect, useState, type FormEvent } from "react";

import { Api, currentUsername, type Role, type StaffMember } from "../api";
import { Modal } from "../components/Modal";
import { dateTime } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

const ROLES: Role[] = ["owner", "manager", "receptionist"];

export default function Staff() {
  const t = useT();
  const { club, canManage } = useClub();
  const notify = useToast();
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const me = currentUsername();
  const isOwner = club.role === "owner";
  // Owners manage everyone; managers manage receptionists only (the API enforces this too).
  const assignable = isOwner ? ROLES : (["receptionist"] as Role[]);

  const load = () =>
    Api.staff(club.id)
      .then(setStaff)
      .catch((e) => setError(errorText(e, t)));

  useEffect(() => {
    if (canManage) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id, canManage]);

  if (!canManage) {
    return (
      <div className="page">
        <div className="card empty">
          <h3>{t("common.managersOnly")}</h3>
        </div>
      </div>
    );
  }

  const changeRole = async (member: StaffMember, role: Role) => {
    try {
      await Api.changeStaffRole(member.id, role);
      notify(t("common.saved"));
      load();
    } catch (e) {
      notify(errorText(e, t), "error");
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await Api.removeStaff(removing.id);
      notify(t("staff.removed", { name: removing.username }));
      setRemoving(null);
      load();
    } catch (e) {
      notify(errorText(e, t), "error");
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.staff")}</p>
          <h1>{t("staff.title")}</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + {t("staff.add")}
        </button>
      </header>
      <p className="note">{isOwner ? t("staff.hintOwner") : t("staff.hintManager")}</p>
      {error && <div className="alert">{error}</div>}

      {staff && (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("staff.username")}</th>
                  <th>{t("staff.name")}</th>
                  <th>{t("staff.role")}</th>
                  <th>{t("staff.lastLogin")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {staff.map((m) => {
                  const editable = m.username !== me && (isOwner || m.role === "receptionist");
                  return (
                    <tr key={m.id}>
                      <td className="strong">
                        {m.username}
                        {m.username === me && <span className="tag">{t("staff.you")}</span>}
                      </td>
                      <td>{m.full_name || "—"}</td>
                      <td>
                        {editable ? (
                          <select value={m.role} onChange={(e) => changeRole(m, e.target.value as Role)} aria-label={t("staff.role")}>
                            {assignable.map((r) => (
                              <option key={r} value={r}>
                                {t(`role.${r}`)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={`role role-${m.role}`}>{t(`role.${m.role}`)}</span>
                        )}
                      </td>
                      <td>{m.last_login ? dateTime(m.last_login, club.timezone) : t("staff.never")}</td>
                      <td className="num">
                        {editable && (
                          <button className="btn btn-small btn-danger-ghost" onClick={() => setRemoving(m)}>
                            {t("staff.remove")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && (
        <AddStaffModal
          roles={assignable}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      {removing && (
        <Modal
          title={t("staff.removeTitle", { name: removing.username })}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRemoving(null)}>
                {t("common.keep")}
              </button>
              <button className="btn btn-danger" onClick={remove}>
                {t("staff.remove")}
              </button>
            </>
          }
        >
          <p>{t("staff.removeExplain")}</p>
        </Modal>
      )}
    </div>
  );
}

function AddStaffModal({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [username, setUsername] = useState("");
  const [firstName, setFirstName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("receptionist");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.addStaff({ club: club.id, username: username.trim(), password, first_name: firstName.trim(), role });
      notify(t("staff.added", { name: username.trim() }));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("staff.add")}
      subtitle={t("staff.addHint")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="staff-form" disabled={busy}>
            {busy ? t("common.saving") : t("staff.add")}
          </button>
        </>
      }
    >
      <form id="staff-form" className="form" onSubmit={submit}>
        <div className="field-row">
          <label className="field">
            <span>{t("staff.username")}</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={150} autoComplete="off" dir="ltr" />
          </label>
          <label className="field">
            <span>{t("staff.name")}</span>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={150} placeholder={t("common.optional")} />
          </label>
        </div>
        <label className="field">
          <span>{t("staff.password")}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <small className="muted">{t("staff.passwordHint")}</small>
        </label>
        <div className="field">
          <span>{t("staff.role")}</span>
          <div className="segmented">
            {roles.map((r) => (
              <button type="button" key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
                {t(`role.${r}`)}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
