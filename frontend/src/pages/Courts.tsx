import { useEffect, useState, type FormEvent } from "react";

import { Api, messageOf, type Court } from "../api";
import { CourtArt } from "../components/Brand";
import { Modal } from "../components/Modal";
import { useClub, useToast } from "../session";

export default function Courts() {
  const { club, canManage } = useClub();
  const [courts, setCourts] = useState<Court[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Court | "new" | null>(null);

  const load = () =>
    Api.courts()
      .then((list) => setCourts(list.filter((c) => c.club === club.id)))
      .catch((e) => setError(messageOf(e)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Courts</p>
          <h1>{club.name}</h1>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            + Add court
          </button>
        )}
      </header>

      {!canManage && (
        <p className="note">You can view courts. Only the owner or a manager can add or change them.</p>
      )}
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
                  <span className="tag">{court.kind === "indoor" ? "Indoor" : "Outdoor"}</span>
                  <span className={`tag ${court.is_active ? "tag-ok" : "tag-off"}`}>
                    {court.is_active ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
              {canManage && (
                <button className="btn btn-small" onClick={() => setEditing(court)}>
                  Edit
                </button>
              )}
            </div>
          </article>
        ))}
        {courts?.length === 0 && (
          <div className="card empty">
            <h3>No courts yet</h3>
            <p className="muted">Add your first court to open it for bookings.</p>
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

function CourtModal({
  court,
  onClose,
  onSaved,
}: {
  court: Court | null;
  onClose: () => void;
  onSaved: () => void;
}) {
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
      notify(court ? "Court saved" : `${body.name} added`);
      onSaved();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={court ? `Edit ${court.name}` : "Add a court"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" form="court-form" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="court-form" className="form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Court 3" />
        </label>
        <div className="field">
          <span>Type</span>
          <div className="segmented">
            {(["indoor", "outdoor"] as const).map((k) => (
              <button type="button" key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {k === "indoor" ? "Indoor" : "Outdoor"}
              </button>
            ))}
          </div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>
            Open for bookings
            <small className="muted">
              Courts are never deleted, because past bookings point at them. Switch this off instead.
            </small>
          </span>
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
