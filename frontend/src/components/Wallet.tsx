import { useEffect, useState, type FormEvent } from "react";

import { Api, type BalanceEntry, type Customer, type MoneyMethod, type TopUpPlan } from "../api";
import { dateTime, minus, money } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import { CashCalculator } from "./CashCalculator";
import { Modal } from "./Modal";

const MONEY: MoneyMethod[] = ["cash", "card", "transfer"];

function bonusOf(plan: Pick<TopUpPlan, "price" | "credit">) {
  return Number(plan.credit) - Number(plan.price);
}

/** A customer's prepaid balance, with top-up and history. */
export function BalanceCard({ customer, onChanged }: { customer: Customer; onChanged: () => void }) {
  const t = useT();
  const { club } = useClub();
  const [balance, setBalance] = useState(Number(customer.balance));
  const [topping, setTopping] = useState(false);
  const [history, setHistory] = useState<BalanceEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = () =>
    Api.balanceHistory(customer.id)
      .then((entries) => {
        setHistory(entries);
        setBalance(entries.reduce((sum, e) => sum + Number(e.amount), 0));
      })
      .catch(() => setHistory([]));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.id]);

  return (
    <section className="wallet-card">
      <div className="wallet-head">
        <span>
          <small>{t("wallet.balance")}</small>
          <strong>{money(balance, club.currency)}</strong>
        </span>
        <button type="button" className="btn btn-primary btn-small" onClick={() => setTopping(true)}>
          + {t("wallet.topUp")}
        </button>
      </div>
      {history && history.length > 0 && (
        <button type="button" className="link-btn" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? "▾" : "▸"} {t("wallet.history")}
        </button>
      )}
      {showHistory &&
        history?.map((e) => (
          <div key={e.id} className="wallet-row">
            <span className="grow">
              {t(`wallet.kind.${e.kind}`)}
              {e.plan_name && ` · ${e.plan_name}`}
              {e.paid && ` · ${t("wallet.paidWith", { amount: money(e.paid, club.currency), method: t(`method.${e.method}`) })}`}
              <small>
                {dateTime(e.created_at, club.timezone)}
                {e.created_by_name && ` · ${e.created_by_name}`}
                {e.note && ` · ${e.note}`}
              </small>
            </span>
            <strong className={Number(e.amount) < 0 ? "due-text" : "ok-text"}>
              {Number(e.amount) < 0 ? minus(money(-Number(e.amount), club.currency)) : `+${money(e.amount, club.currency)}`}
            </strong>
          </div>
        ))}
      {topping && (
        <TopUpModal
          customer={customer}
          onClose={() => setTopping(false)}
          onDone={() => {
            setTopping(false);
            load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function TopUpModal({ customer, onClose, onDone }: { customer: Customer; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [plans, setPlans] = useState<TopUpPlan[]>([]);
  const [plan, setPlan] = useState<TopUpPlan | null>(null);
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState<MoneyMethod>("cash");
  const [received, setReceived] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Api.plans(club.id)
      .then((list) => setPlans(list.filter((p) => p.is_active)))
      .catch(() => setPlans([]));
  }, [club.id]);

  const due = plan ? Number(plan.price) : Number(paid) || 0;
  const credit = plan ? Number(plan.credit) : due;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.topUp(customer.id, plan ? { plan: plan.id, method, note: "" } : { paid, method, note: "" });
      notify(t("wallet.toppedUp", { name: customer.name, amount: money(credit, club.currency) }));
      onDone();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("wallet.topUpTitle", { name: customer.name })}
      onClose={onClose}
      footer={
        <>
          <span className="total">
            {money(due, club.currency)}
            {credit > due && <small>{t("wallet.getsCredit", { amount: money(credit, club.currency) })}</small>}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="topup-form" disabled={busy || due <= 0}>
            {busy ? t("common.saving") : t("wallet.confirm", { amount: money(due, club.currency) })}
          </button>
        </>
      }
    >
      <form id="topup-form" className="form" onSubmit={submit}>
        {plans.length > 0 && (
          <div className="plan-grid">
            {plans.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`plan-card${plan?.id === p.id ? " on" : ""}`}
                onClick={() => setPlan(plan?.id === p.id ? null : p)}
              >
                <span>{p.name}</span>
                <strong>{money(p.price, club.currency)}</strong>
                {bonusOf(p) > 0 && <em>+{money(bonusOf(p), club.currency)}</em>}
                <small>{t("wallet.getsCredit", { amount: money(p.credit, club.currency) })}</small>
              </button>
            ))}
          </div>
        )}
        {!plan && (
          <label className="field">
            <span>{plans.length > 0 ? t("wallet.orAmount") : t("bill.amount")}</span>
            <input type="number" min="1" step="0.01" value={paid} onChange={(e) => setPaid(e.target.value)} />
          </label>
        )}
        <div className="segmented">
          {MONEY.map((m) => (
            <button type="button" key={m} className={method === m ? "on" : ""} onClick={() => setMethod(m)}>
              {t(`method.${m}`)}
            </button>
          ))}
        </div>
        {method === "cash" && <CashCalculator due={due} received={received} onChange={setReceived} />}
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}

/** Owners and managers: the packages customers can buy. */
export function PlansManager() {
  const t = useT();
  const { club, canManage } = useClub();
  const [plans, setPlans] = useState<TopUpPlan[] | null>(null);
  const [editing, setEditing] = useState<TopUpPlan | "new" | null>(null);

  const load = () =>
    Api.plans(club.id)
      .then(setPlans)
      .catch(() => setPlans([]));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [club.id]);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{t("wallet.packages")}</h2>
          <p className="muted">{t("wallet.packagesHint")}</p>
        </div>
        {canManage && (
          <button className="btn btn-small btn-primary" onClick={() => setEditing("new")}>
            + {t("wallet.addPackage")}
          </button>
        )}
      </div>
      {plans?.length === 0 && <p className="muted">{t("wallet.noPackages")}</p>}
      <div className="plan-grid">
        {plans?.map((p) => (
          <div key={p.id} className={`plan-card static${p.is_active ? "" : " is-off"}`}>
            <span>{p.name}</span>
            <strong>{money(p.price, club.currency)}</strong>
            {bonusOf(p) > 0 && (
              <em>
                +{money(bonusOf(p), club.currency)} · {Math.round((bonusOf(p) / Number(p.price)) * 100)}%
              </em>
            )}
            <small>{t("wallet.getsCredit", { amount: money(p.credit, club.currency) })}</small>
            {canManage && (
              <button className="btn btn-small" onClick={() => setEditing(p)}>
                {t("common.edit")}
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <PlanModal
          plan={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function PlanModal({ plan, onClose, onSaved }: { plan: TopUpPlan | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [name, setName] = useState(plan?.name ?? "");
  const [price, setPrice] = useState(plan ? String(Number(plan.price)) : "");
  const [credit, setCredit] = useState(plan ? String(Number(plan.credit)) : "");
  const [active, setActive] = useState(plan?.is_active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bonus = (Number(credit) || 0) - (Number(price) || 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { club: club.id, name: name.trim(), price, credit, is_active: active };
    try {
      if (plan) await Api.updatePlan(plan.id, body);
      else await Api.createPlan(body);
      notify(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await Api.deletePlan(plan.id);
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={plan ? t("wallet.editPackage") : t("wallet.addPackage")}
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <span className="muted grow">{t("wallet.confirmDelete")}</span>
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              {t("common.keep")}
            </button>
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              {t("common.delete")}
            </button>
          </>
        ) : (
          <>
            {plan && (
              <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                {t("common.delete")}
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>
              {t("common.close")}
            </button>
            <button className="btn btn-primary" form="plan-form" disabled={busy}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
          </>
        )
      }
    >
      <form id="plan-form" className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("wallet.packageName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder={t("wallet.packagePlaceholder")} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{t("wallet.price", { currency: club.currency })}</span>
            <input type="number" min="1" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </label>
          <label className="field">
            <span>{t("wallet.credit", { currency: club.currency })}</span>
            <input type="number" min="1" step="0.01" value={credit} onChange={(e) => setCredit(e.target.value)} required />
          </label>
        </div>
        {bonus > 0 && <p className="hint">{t("wallet.bonusHint", { amount: money(bonus, club.currency) })}</p>}
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>{t("menu.onSale")}</span>
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
