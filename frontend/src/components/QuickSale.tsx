import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Api, type PaymentMethod, type Product } from "../api";
import { money } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import { CashCalculator } from "./CashCalculator";
import { CustomerFields } from "./CustomerField";
import { Modal } from "./Modal";

const METHODS: PaymentMethod[] = ["cash", "card", "transfer"];

/** Sell buffet products at the counter, without a court booking. */
export function QuickSaleModal({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [received, setReceived] = useState("");
  const [withCustomer, setWithCustomer] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Api.products(club.id)
      .then((list) => setProducts(list.filter((p) => p.is_active)))
      .catch((e) => setError(errorText(e, t)));
  }, [club.id, t]);

  const groups = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products ?? []) {
      const key = p.category || t("menu.other");
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()];
  }, [products, t]);

  const lines = (products ?? []).filter((p) => cart[p.id]).map((p) => ({ product: p, quantity: cart[p.id] }));
  const total = lines.reduce((sum, l) => sum + Number(l.product.price) * l.quantity, 0);
  const change = (id: number, delta: number) =>
    setCart((c) => {
      const next = Math.max(0, (c[id] ?? 0) + delta);
      const copy = { ...c };
      if (next) copy[id] = next;
      else delete copy[id];
      return copy;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const sale = await Api.createSale({
        club: club.id,
        items: lines.map((l) => ({ product: l.product.id, quantity: l.quantity })),
        method,
        customer_name: withCustomer ? name.trim() : "",
        customer_phone: withCustomer ? phone.trim() : "",
      });
      notify(t("sale.done", { amount: money(sale.total, club.currency) }));
      onDone?.();
      onClose();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={t("sale.title")}
      subtitle={t("sale.subtitle")}
      onClose={onClose}
      footer={
        <>
          <span className="total">
            {money(total, club.currency)}
            <small>{t("bill.total")}</small>
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="quick-sale" disabled={busy || lines.length === 0}>
            {busy ? t("common.saving") : t("sale.charge", { amount: money(total, club.currency) })}
          </button>
        </>
      }
    >
      {products?.length === 0 && <p className="muted">{t("menu.emptyHint")}</p>}
      {groups.map(([category, items]) => (
        <div key={category} className="menu-group">
          <h4>{category}</h4>
          <div className="menu-grid">
            {items.map((p) => (
              <div key={p.id} className={`menu-tile sale-tile${cart[p.id] ? " in-cart" : ""}`}>
                <button type="button" className="sale-add" onClick={() => change(p.id, 1)}>
                  <span>{p.name}</span>
                  <strong>{money(p.price, club.currency)}</strong>
                </button>
                {cart[p.id] ? (
                  <span className="stepper">
                    <button type="button" onClick={() => change(p.id, -1)} aria-label={t("bill.less")}>
                      −
                    </button>
                    <b>{cart[p.id]}</b>
                    <button type="button" onClick={() => change(p.id, 1)} aria-label={t("bill.more")}>
                      +
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}

      <form id="quick-sale" className="form sale-form" onSubmit={submit}>
        {lines.length > 0 && (
          <div className="sale-summary">
            {lines.map((l) => (
              <div key={l.product.id} className="bill-line">
                <span>
                  {l.product.name}
                  <small>
                    {money(l.product.price, club.currency)} × {l.quantity}
                  </small>
                </span>
                <strong>{money(Number(l.product.price) * l.quantity, club.currency)}</strong>
              </div>
            ))}
          </div>
        )}
        <div className="segmented">
          {METHODS.map((m) => (
            <button type="button" key={m} className={method === m ? "on" : ""} onClick={() => setMethod(m)}>
              {t(`method.${m}`)}
            </button>
          ))}
        </div>
        {method === "cash" && <CashCalculator due={total} received={received} onChange={setReceived} />}
        {withCustomer ? (
          <CustomerFields
            name={name}
            phone={phone}
            onChange={(n, p) => {
              setName(n);
              setPhone(p);
            }}
          />
        ) : (
          <button type="button" className="link-btn" onClick={() => setWithCustomer(true)}>
            + {t("sale.addCustomer")}
          </button>
        )}
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
