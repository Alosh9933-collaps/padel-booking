import { useEffect, useState, type FormEvent } from "react";

import { Api, type Court } from "../api";
import { CourtArt } from "../components/Brand";
import { Modal } from "../components/Modal";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

export default function Courts() {
  const t = useT();
  const { club, canManage } = useClub();
  const [courts, setCourts] = useState<Court[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Court | "new" | null>(null);

  const load = () =>
    Api.courts()
      .then((list) => setCourts(list.filter((c) => c.club === club.id)))
      .catch((e) => setError(errorText(e, t)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.courts")}</p>
          <h1>{club.name}</h1>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            + {t("courts.add")}
          </button>
        )}
      </header>

      {!canManage && <p className="note">{t("courts.readOnly")}</p>}
      {error && <div className="alert">{error}</div>}

      <div className="court-grid">
        {courts?.map((court) => (
          <article key={court.id} className={`court-card${court.is_active ? "" : " is-off"}`}>
            <CourtArt
              className="court-card-art"
              surface={court.kind === "outdoor" ? "var(--turf)" : "var(--court)"}
              showBall={court.is_active}
            />
            <div className="court-card-body">
              <div>
                <h3>{court.name}</h3>
                <div className="tags">
                  <span className="tag">{t(`courts.${court.kind}`)}</span>
                  <span className={`tag ${court.is_active ? "tag-ok" : "tag-off"}`}>
                    {court.is_active ? t("courts.active") : t("courts.inactive")}
                  </span>
                </div>
              </div>
              {canManage && (
                <button className="btn btn-small" onClick={() => setEditing(court)}>
                  {t("common.edit")}
                </button>
              )}
            </div>
          </article>
        ))}
        {courts?.length === 0 && (
          <div className="card empty">
            <h3>{t("courts.empty")}</h3>
            <p className="muted">{t("courts.emptyHint")}</p>
          </div>
        )}
      </div>

      {editing && (
        <CourtModal
          court={editing === "new" ? null : editing}
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

function CourtModal({ court, onClose, onSaved }: { court: Court | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [name, setName] = useState(court?.name ?? "");
  const [kind, setKind] = useState<Court["kind"]>(court?.kind ?? "indoor");
  const [active, setActive] = useState(court?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { club: club.id, name: name.trim(), kind, is_active: active };
    try {
      if (court) await Api.updateCourt(court.id, body);
      else await Api.createCourt(body);
      notify(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={court ? t("courts.edit", { name: court.name }) : t("courts.add")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="court-form" disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <form id="court-form" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("courts.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder={t("courts.namePlaceholder")} />
        </label>
        <div className="field">
          <span>{t("courts.type")}</span>
          <div className="segmented">
            {(["indoor", "outdoor"] as const).map((k) => (
              <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {t(`courts.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>
            {t("courts.openForBookings")}
            <small className="muted">{t("courts.neverDeleted")}</small>
          </span>
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
