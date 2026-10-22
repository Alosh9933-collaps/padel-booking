import { useEffect, useState, type FormEvent } from "react";

import { Api, type Booking, type Customer } from "../api";
import { BillModal, PaymentBadge } from "../components/Bill";
import { Modal } from "../components/Modal";
import { clockTime, dateIn, ltr, money, shortDate } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import { useNow } from "./Schedule";

export default function Customers() {
  const t = useT();
  const { club } = useClub();
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Customer | "new" | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.customers(club.id, search.trim())
        .then((list) => !cancelled && setCustomers(list))
        .catch((e) => !cancelled && setError(errorText(e, t)));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [club.id, search, version, t]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.customers")}</p>
          <h1>{t("customers.title")}</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen("new")}>
          + {t("customers.add")}
        </button>
      </header>

      <input
        className="search"
        type="search"
        placeholder={t("customers.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label={t("customers.search")}
      />
      {error && <div className="alert">{error}</div>}

      {customers && customers.length === 0 && (
        <div className="card empty">
          <h3>{search ? t("customers.noMatch") : t("customers.empty")}</h3>
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
                  <th className="num">{t("customers.visits")}</th>
                  <th className="num">{t("customers.noShows")}</th>
                  <th className="num">{t("customers.spent")}</th>
                  <th>{t("customers.lastVisit")}</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(c)}>
                    <td className="strong">{c.name}</td>
                    <td dir="ltr" className="phone">{c.phone || "—"}</td>
                    <td className="num">{c.visits}</td>
                    <td className="num">{c.no_shows > 0 ? <span className="warn-text">{c.no_shows}</span> : 0}</td>
                    <td className="num strong">{money(c.spent, club.currency)}</td>
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
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

function CustomerModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const now = useNow();
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
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
    const body = { club: club.id, name: name.trim(), phone: phone.trim(), notes };
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
              {b.status === "confirmed" ? <PaymentBadge booking={b} /> : <span className="chip chip-off">{t(`status.${b.status}`)}</span>}
              <strong>{money(b.total, club.currency)}</strong>
            </button>
          ))}
        </section>
      )}
    </Modal>
  );
}
