import { useEffect, useState, type FormEvent } from "react";

import { Api, type CustomerCategory, type DiscountSettings } from "../api";
import { Modal } from "../components/Modal";
import { PlansManager } from "../components/Wallet";
import { minus } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

/** The first three reward visits, e.g. 10, 20, 30. */
function visitExamples(every: number) {
  return { a: every, b: every * 2, c: every * 3 };
}

const COLORS = ["#1d6fd1", "#2f9a6a", "#d97a1f", "#c93a3a", "#7c4dcc", "#0b2340", "#b5a40c", "#e0559a"];

/** The club's loyalty rules and customer categories. Staff read; owners and managers edit. */
export default function Loyalty() {
  const t = useT();
  const { club, canManage } = useClub();
  const notify = useToast();
  const [rules, setRules] = useState<DiscountSettings | null>(null);
  const [saved, setSaved] = useState<DiscountSettings | null>(null);
  const [categories, setCategories] = useState<CustomerCategory[] | null>(null);
  const [editing, setEditing] = useState<CustomerCategory | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCategories = () =>
    Api.categories(club.id)
      .then(setCategories)
      .catch((e) => setError(errorText(e, t)));

  useEffect(() => {
    Api.discountSettings(club.id)
      .then((r) => {
        setRules(r);
        setSaved(r);
      })
      .catch((e) => setError(errorText(e, t)));
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  const set = <K extends keyof DiscountSettings>(key: K, value: DiscountSettings[K]) =>
    setRules((r) => (r ? { ...r, [key]: value } : r));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await Api.updateDiscountSettings(club.id, rules);
      setRules(fresh);
      setSaved(fresh);
      notify(t("common.saved"));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);

  return (
    <>
      <p className="note">{t("loyalty.explain")}</p>
      {!canManage && <p className="note">{t("loyalty.readOnly")}</p>}
      {error && <div className="alert">{error}</div>}

      <div className="settings-grid">
        {rules && (
          <section className="card">
            <div className="card-head">
              <h2>{t("loyalty.rules")}</h2>
            </div>
            <form className="form" onSubmit={save}>
              <div className={`rule${rules.first_visit_enabled ? " is-on" : ""}`}>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={rules.first_visit_enabled}
                    disabled={!canManage}
                    onChange={(e) => set("first_visit_enabled", e.target.checked)}
                  />
                  <span className="switch-track" aria-hidden />
                  <span>
                    {t("loyalty.firstVisit")}
                    <small className="muted">{t("loyalty.firstVisitHint")}</small>
                  </span>
                </label>
                <label className="rule-input">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={rules.first_visit_percent}
                    disabled={!canManage || !rules.first_visit_enabled}
                    onChange={(e) => set("first_visit_percent", Number(e.target.value))}
                  />
                  <span>{t("loyalty.percentOffCourt")}</span>
                </label>
              </div>

              <div className={`rule${rules.nth_visit_enabled ? " is-on" : ""}`}>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={rules.nth_visit_enabled}
                    disabled={!canManage}
                    onChange={(e) => set("nth_visit_enabled", e.target.checked)}
                  />
                  <span className="switch-track" aria-hidden />
                  <span>
                    {t("loyalty.nthVisit")}
                    <small className="muted">{t("loyalty.nthVisitHint")}</small>
                  </span>
                </label>
                <div className="rule-inputs">
                  <label className="rule-input">
                    <span>{t("loyalty.every")}</span>
                    <input
                      type="number"
                      min={2}
                      max={100}
                      value={rules.nth_visit_every}
                      disabled={!canManage || !rules.nth_visit_enabled}
                      onChange={(e) => set("nth_visit_every", Number(e.target.value))}
                    />
                    <span>{t("loyalty.visits")}</span>
                  </label>
                  <label className="rule-input">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={rules.nth_visit_percent}
                      disabled={!canManage || !rules.nth_visit_enabled}
                      onChange={(e) => set("nth_visit_percent", Number(e.target.value))}
                    />
                    <span>{t("loyalty.percentOffCourt")}</span>
                  </label>
                </div>
                {rules.nth_visit_enabled && (
                  <p className="hint">
                    {rules.nth_visit_percent >= 100
                      ? t("loyalty.exampleFree", visitExamples(rules.nth_visit_every))
                      : t("loyalty.example", { ...visitExamples(rules.nth_visit_every), percent: rules.nth_visit_percent })}
                  </p>
                )}
              </div>

              {canManage && (
                <div className="form-actions">
                  <button className="btn btn-primary" disabled={!dirty || busy}>
                    {busy ? t("common.saving") : t("settings.save")}
                  </button>
                </div>
              )}
            </form>
          </section>
        )}

        <section className="card">
          <div className="card-head">
            <div>
              <h2>{t("loyalty.categories")}</h2>
              <p className="muted">{t("loyalty.categoriesHint")}</p>
            </div>
            {canManage && (
              <button className="btn btn-small btn-primary" onClick={() => setEditing("new")}>
                + {t("loyalty.addCategory")}
              </button>
            )}
          </div>
          {categories?.length === 0 && <p className="muted">{t("loyalty.noCategories")}</p>}
          {categories?.map((c) => (
            <div key={c.id} className="cat-row" style={{ ["--cat" as string]: c.color }}>
              <i aria-hidden />
              <span className="grow">
                <strong>{c.name}</strong>
                <small>{t("loyalty.customersCount", { count: c.customers })}</small>
              </span>
              {c.discount_percent > 0 ? (
                <span className="chip chip-discount">{minus(`${c.discount_percent}%`)}</span>
              ) : (
                <span className="chip">{t("loyalty.noDiscount")}</span>
              )}
              {canManage && (
                <button className="btn btn-small" onClick={() => setEditing(c)}>
                  {t("common.edit")}
                </button>
              )}
            </div>
          ))}
        </section>
      </div>

      <PlansManager />

      {editing && (
        <CategoryModal
          category={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadCategories();
          }}
        />
      )}
    </>
  );
}

function CategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category: CustomerCategory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? COLORS[0]);
  const [percent, setPercent] = useState(category?.discount_percent ?? 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { club: club.id, name: name.trim(), color, discount_percent: percent };
    try {
      if (category) await Api.updateCategory(category.id, body);
      else await Api.createCategory(body);
      notify(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!category) return;
    setBusy(true);
    try {
      await Api.deleteCategory(category.id);
      notify(t("loyalty.categoryDeleted"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={category ? t("loyalty.editCategory") : t("loyalty.addCategory")}
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <span className="muted grow">{t("loyalty.confirmDelete")}</span>
            <button className="btn" onClick={() => setConfirmDelete(false)} disabled={busy}>
              {t("common.keep")}
            </button>
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              {t("common.delete")}
            </button>
          </>
        ) : (
          <>
            {category && (
              <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                {t("common.delete")}
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>
              {t("common.close")}
            </button>
            <button className="btn btn-primary" form="category-form" disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
          </>
        )
      }
    >
      <form id="category-form" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("loyalty.categoryName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder={t("loyalty.categoryPlaceholder")} />
        </label>
        <div className="field">
          <span>{t("loyalty.color")}</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={color === c ? "on" : ""}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
                aria-pressed={color === c}
              />
            ))}
          </div>
        </div>
        <label className="field">
          <span>{t("loyalty.categoryDiscount")}</span>
          <input type="number" min={0} max={100} value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
          <small className="muted">{t("loyalty.categoryDiscountHint")}</small>
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
