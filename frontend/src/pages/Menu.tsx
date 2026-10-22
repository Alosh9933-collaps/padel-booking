import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Api, type Product } from "../api";
import { Modal } from "../components/Modal";
import { money } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

export default function Menu() {
  const t = useT();
  const { club, canManage } = useClub();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);

  const load = () =>
    Api.products(club.id)
      .then(setProducts)
      .catch((e) => setError(errorText(e, t)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  const groups = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products ?? []) {
      const key = p.category || t("menu.other");
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()];
  }, [products, t]);

  const categories = useMemo(
    () => [...new Set((products ?? []).map((p) => p.category).filter(Boolean))],
    [products],
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.menu")}</p>
          <h1>{t("menu.title")}</h1>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            + {t("menu.add")}
          </button>
        )}
      </header>
      <p className="note">{canManage ? t("menu.hintManager") : t("menu.hintStaff")}</p>
      {error && <div className="alert">{error}</div>}

      {products?.length === 0 && (
        <div className="card empty">
          <h3>{t("menu.empty")}</h3>
          <p className="muted">{t("menu.emptyHint")}</p>
        </div>
      )}

      {groups.map(([category, items]) => (
        <section key={category} className="menu-section">
          <h2>{category}</h2>
          <div className="product-grid">
            {items.map((p) => (
              <article key={p.id} className={`product-card${p.is_active ? "" : " is-off"}`}>
                <div>
                  <h3>{p.name}</h3>
                  {!p.is_active && <span className="tag tag-off">{t("menu.hidden")}</span>}
                </div>
                <strong>{money(p.price, club.currency)}</strong>
                {canManage && (
                  <button className="btn btn-small" onClick={() => setEditing(p)}>
                    {t("common.edit")}
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <ProductModal
          product={editing === "new" ? null : editing}
          categories={categories}
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

function ProductModal({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [price, setPrice] = useState(product ? String(Number(product.price)) : "");
  const [active, setActive] = useState(product?.is_active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { club: club.id, name: name.trim(), category: category.trim(), price, is_active: active };
    try {
      if (product) await Api.updateProduct(product.id, body);
      else await Api.createProduct(body);
      notify(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!product) return;
    setBusy(true);
    try {
      await Api.deleteProduct(product.id);
      notify(t("menu.deleted"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={product ? t("menu.edit") : t("menu.add")}
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <span className="muted grow">{t("menu.confirmDelete")}</span>
            <button className="btn" onClick={() => setConfirmDelete(false)} disabled={busy}>
              {t("common.keep")}
            </button>
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              {t("common.delete")}
            </button>
          </>
        ) : (
          <>
            {product && (
              <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                {t("common.delete")}
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>
              {t("common.close")}
            </button>
            <button className="btn btn-primary" form="product-form" disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
          </>
        )
      }
    >
      <form id="product-form" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("menu.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={t("menu.namePlaceholder")} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{t("menu.category")}</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} list="menu-categories" placeholder={t("menu.categoryPlaceholder")} />
            <datalist id="menu-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>{t("menu.price", { currency: club.currency })}</span>
            <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </label>
        </div>
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>
            {t("menu.onSale")}
            <small className="muted">{t("menu.onSaleHint")}</small>
          </span>
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
