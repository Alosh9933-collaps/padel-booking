import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";

import { Api, type Booking, type Customer, type CustomerCategory, type DiscountSettings } from "../api";
import { BillModal, PaymentBadge } from "../components/Bill";
import { Modal } from "../components/Modal";
import { BalanceCard } from "../components/Wallet";
import { clockTime, dateIn, ltr, minus, money, shortDate } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import Loyalty from "./Loyalty";
import { useNow } from "./Schedule";

export function CategoryBadge({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return null;
  return (
    <span className="cat-badge" style={{ ["--cat" as string]: color ?? "#6d7a8a" }}>
      <i aria-hidden />
      {name}
    </span>
  );
}

/** "7/10": where a customer stands on the way to the next loyalty visit. */
function LoyaltyProgress({ visits, rules }: { visits: number; rules: DiscountSettings | null }) {
  const t = useT();
  if (!rules?.nth_visit_enabled) return null;
  const every = rules.nth_visit_every;
  const done = visits % every;
  const nextIsReward = done === every - 1;
  return (
    <span className={`loyalty${nextIsReward ? " is-next" : ""}`} title={t("loyalty.progressTitle", { every, percent: rules.nth_visit_percent })}>
      <span className="loyalty-bar" aria-hidden>
        <span style={{ width: `${(done / every) * 100}%` }} />
      </span>
      {nextIsReward ? `🎁 ${t("loyalty.nextIsReward")}` : `${done}/${every}`}
    </span>
  );
}

export default function Customers() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "loyalty" ? "loyalty" : "list";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.customers")}</p>
          <h1>{tab === "list" ? t("customers.title") : t("loyalty.title")}</h1>
        </div>
        <div className="segmented tabs" role="tablist">
          <button role="tab" aria-selected={tab === "list"} className={tab === "list" ? "on" : ""} onClick={() => setParams({})}>
            {t("customers.tabList")}
          </button>
          <button
            role="tab"
            aria-selected={tab === "loyalty"}
            className={tab === "loyalty" ? "on" : ""}
            onClick={() => setParams({ tab: "loyalty" })}
          >
            🎁 {t("customers.tabLoyalty")}
          </button>
        </div>
      </header>
      {tab === "list" ? <CustomerList /> : <Loyalty />}
    </div>
  );
}

function CustomerList() {
  const t = useT();
  const { club } = useClub();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [categories, setCategories] = useState<CustomerCategory[]>([]);
  const [rules, setRules] = useState<DiscountSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Customer | "new" | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    Promise.all([Api.categories(club.id), Api.discountSettings(club.id)])
      .then(([c, r]) => {
        setCategories(c);
        setRules(r);
      })
      .catch((e) => setError(errorText(e, t)));
  }, [club.id, version, t]);

  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.customers(club.id, search.trim(), category)
        .then((list) => !cancelled && setCustomers(list))
        .catch((e) => !cancelled && setError(errorText(e, t)));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [club.id, search, category, version, t]);

  return (
    <>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder={t("customers.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("customers.search")}
        />
        <button className="btn btn-primary" onClick={() => setOpen("new")}>
          + {t("customers.add")}
        </button>
      </div>
      {categories.length > 0 && (
        <div className="cat-filter" role="group" aria-label={t("customers.category")}>
          <button className={category === "" ? "on" : ""} onClick={() => setCategory("")}>
            {t("customers.all")}
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className={category === String(c.id) ? "on" : ""}
              onClick={() => setCategory(String(c.id))}
              style={{ ["--cat" as string]: c.color }}
            >
              <i aria-hidden />
              {c.name}
              <small>{c.customers}</small>
            </button>
          ))}
          <button className={category === "none" ? "on" : ""} onClick={() => setCategory("none")}>
            {t("customers.uncategorized")}
          </button>
        </div>
      )}
      {error && <div className="alert">{error}</div>}

      {customers && customers.length === 0 && (
        <div className="card empty">
          <h3>{search || category ? t("customers.noMatch") : t("customers.empty")}</h3>
          <p className="muted">{t("customers.emptyHint")}</p>
        </div>
      )}

      {customers && customers.length > 0 && (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>{t("customers.name")}</th>
                  <th>{t("customers.phone")}</th>
                  <th>{t("customers.category")}</th>
                  <th className="num">{t("customers.visits")}</th>
                  {rules?.nth_visit_enabled && <th>{t("loyalty.progress")}</th>}
                  <th className="num">{t("customers.noShows")}</th>
                  <th className="num">{t("customers.spent")}</th>
                  <th className="num">{t("wallet.balance")}</th>
                  <th>{t("customers.lastVisit")}</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(c)}>
                    <td className="strong">
                      {c.name}
                      {c.visits === 0 && <span className="tag tag-new">{t("customers.new")}</span>}
                    </td>
                    <td dir="ltr" className="phone">
                      {c.phone || "—"}
                    </td>
                    <td>
                      <CategoryBadge name={c.category_name} color={c.category_color} />
                    </td>
                    <td className="num">{c.visits}</td>
                    {rules?.nth_visit_enabled && (
                      <td>
                        <LoyaltyProgress visits={c.visits} rules={rules} />
                      </td>
                    )}
                    <td className="num">{c.no_shows > 0 ? <span className="warn-text">{c.no_shows}</span> : 0}</td>
                    <td className="num strong">{money(c.spent, club.currency)}</td>
                    <td className="num">{Number(c.balance) !== 0 ? <span className="ok-text strong">{money(c.balance, club.currency)}</span> : "—"}</td>
                    <td>{c.last_visit ? shortDate(dateIn(c.last_visit, club.timezone)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && (
        <CustomerModal
          customer={open === "new" ? null : open}
          categories={categories}
          rules={rules}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            setVersion((v) => v + 1);
          }}
          onRefresh={() => setVersion((v) => v + 1)}
        />
      )}
    </>
  );
}

function CustomerModal({
  customer,
  categories,
  rules,
  onClose,
  onSaved,
  onRefresh,
}: {
  customer: Customer | null;
  categories: CustomerCategory[];
  rules: DiscountSettings | null;
  onClose: () => void;
  onSaved: () => void;
  /** Something changed (like the balance) but the window stays open. */
  onRefresh: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const now = useNow();
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [category, setCategory] = useState<number | null>(customer?.category ?? null);
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [history, setHistory] = useState<Booking[] | null>(null);
  const [bill, setBill] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!customer) return;
    Api.bookings({ customer: customer.id })
      .then((list) => setHistory(list.reverse()))
      .catch(() => setHistory([]));
  }, [customer]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { club: club.id, name: name.trim(), phone: phone.trim(), notes, category };
    try {
      if (customer) await Api.updateCustomer(customer.id, body);
      else await Api.createCustomer(body);
      notify(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  if (bill !== null) {
    return <BillModal bookingId={bill} now={now} onClose={() => setBill(null)} onChanged={() => setBill(null)} />;
  }

  const chosen = categories.find((c) => c.id === category);

  return (
    <Modal
      wide={Boolean(customer)}
      title={customer ? customer.name : t("customers.add")}
      subtitle={
        customer
          ? `${t("customers.visitsCount", { count: customer.visits })} · ${t("customers.spent")}: ${money(customer.spent, club.currency)}`
          : undefined
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="customer-form" disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      {customer && <BalanceCard customer={customer} onChanged={onRefresh} />}
      {customer && rules?.nth_visit_enabled && (
        <div className="loyalty-card">
          <LoyaltyProgress visits={customer.visits} rules={rules} />
          <span className="muted small">{t("loyalty.progressTitle", { every: rules.nth_visit_every, percent: rules.nth_visit_percent })}</span>
        </div>
      )}
      <form id="customer-form" className="form" onSubmit={submit}>
        <div className="field-row">
          <label className="field">
            <span>{t("customers.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <label className="field">
            <span>{t("customers.phone")}</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} inputMode="tel" dir="ltr" />
          </label>
        </div>
        <div className="field">
          <span>{t("customers.category")}</span>
          <div className="cat-filter cat-pick">
            <button type="button" className={category === null ? "on" : ""} onClick={() => setCategory(null)}>
              {t("customers.noCategory")}
            </button>
            {categories.map((c) => (
              <button
                type="button"
                key={c.id}
                className={category === c.id ? "on" : ""}
                onClick={() => setCategory(c.id)}
                style={{ ["--cat" as string]: c.color }}
              >
                <i aria-hidden />
                {c.name}
                {c.discount_percent > 0 && <small>{minus(`${c.discount_percent}%`)}</small>}
              </button>
            ))}
          </div>
          {categories.length === 0 && <small className="muted">{t("customers.noCategoriesHint")}</small>}
          {chosen && chosen.discount_percent > 0 && (
            <small className="muted">{t("customers.categoryDiscountHint", { percent: chosen.discount_percent })}</small>
          )}
        </div>
        <label className="field">
          <span>{t("customers.notes")}</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t("customers.notesHint")} />
        </label>
        {error && <div className="alert">{error}</div>}
      </form>

      {customer && (
        <section className="history">
          <h3>{t("customers.history")}</h3>
          {history === null && <p className="muted">{t("common.loading")}</p>}
          {history?.length === 0 && <p className="muted">{t("customers.noHistory")}</p>}
          {history?.map((b) => (
            <button key={b.id} className={`history-row status-${b.status}`} onClick={() => setBill(b.id)}>
              <span>
                {shortDate(dateIn(b.start_at, club.timezone))} · {ltr(clockTime(b.start_at, club.timezone))}
                <small>{b.court_name}</small>
              </span>
              {Number(b.discount) > 0 && <span className="chip">{minus(money(b.discount, club.currency))}</span>}
              {b.status === "confirmed" ? <PaymentBadge booking={b} /> : <span className="chip chip-off">{t(`status.${b.status}`)}</span>}
              <strong>{money(b.total, club.currency)}</strong>
            </button>
          ))}
        </section>
      )}
    </Modal>
  );
}
