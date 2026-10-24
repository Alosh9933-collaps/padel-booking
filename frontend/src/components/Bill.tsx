import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  Api,
  type Activity,
  type BookingBill,
  type DiscountInput,
  type PaymentMethod,
  type Product,
} from "../api";
import { clockTime, dateIn, dateTime, duration, longDate, ltr, minus, money, timeRange, zoneOffset } from "../format";
import { errorText, useT } from "../i18n";
import { discountLabel } from "../labels";
import { useClub, useToast } from "../session";
import { ActivityList } from "./ActivityList";
import { CashCalculator } from "./CashCalculator";
import { Modal } from "./Modal";
import { ReceiptModal } from "./Receipt";

const MINUTE = 60_000;
const METHODS: PaymentMethod[] = ["cash", "card", "transfer"];

/** Money methods, plus the customer's prepaid balance when the booking has a customer. */
function methodsFor(bill: BookingBill): PaymentMethod[] {
  return bill.customer_balance !== null ? [...METHODS, "balance"] : METHODS;
}

/** "HH:MM" on a club-local day as ISO with the club's offset. "00:00" as an end means midnight. */
export function localIso(day: string, time: string, timeZone: string, isEnd: boolean) {
  const date = isEnd && time === "00:00" ? nextDay(day) : day;
  return `${date}T${time}:00${zoneOffset(timeZone, date)}`;
}

function nextDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function PaymentBadge({ booking }: { booking: Pick<BookingBill, "payment_status"> }) {
  const t = useT();
  return <span className={`pay-badge pay-${booking.payment_status}`}>{t(`pay.${booking.payment_status}`)}</span>;
}

/** Everything about one booking: the bill, buffet items, payments and actions. */
export function BillModal({
  bookingId,
  now,
  onClose,
  onChanged,
}: {
  bookingId: number;
  now: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { club, canManage } = useClub();
  const notify = useToast();
  const [bill, setBill] = useState<BookingBill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"bill" | "menu" | "edit">("bill");
  const [confirm, setConfirm] = useState<"cancel" | "following" | "no_show" | null>(null);
  const [receipt, setReceipt] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    Api.booking(bookingId)
      .then(setBill)
      .catch((e) => setError(errorText(e, t)));
  }, [bookingId, t]);

  const close = () => {
    if (changed) onChanged();
    else onClose();
  };

  /** Run an API call that returns the fresh bill. */
  const run = async (call: () => Promise<BookingBill>, message?: (b: BookingBill) => string) => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await call();
      setBill(fresh);
      setChanged(true);
      if (message) notify(message(fresh));
      return fresh;
    } catch (e) {
      setError(errorText(e, t));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!bill) {
    return (
      <Modal title={t("bill.title")} onClose={onClose} wide>
        {error ? <div className="alert">{error}</div> : <p className="muted">{t("common.loading")}</p>}
      </Modal>
    );
  }

  if (view === "edit") {
    return (
      <EditTimeModal
        bill={bill}
        onClose={() => setView("bill")}
        onSaved={(fresh) => {
          setBill(fresh);
          setChanged(true);
          setView("bill");
        }}
      />
    );
  }

  const started = Date.parse(bill.start_at);
  const active = bill.status === "confirmed";
  const timeLabel = bill.is_open
    ? t("bill.since", { time: clockTime(bill.start_at, club.timezone) })
    : timeRange(bill.start_at, bill.end_at, club.timezone);
  const canNoShow = active && !bill.is_open && started <= now;

  const doCancel = async () => {
    if (confirm === "following") {
      setBusy(true);
      try {
        const cancelled = await Api.cancelFollowing(bill.id);
        notify(t("bill.cancelledSeries", { count: cancelled.length }));
        onChanged();
      } catch (e) {
        setError(errorText(e, t));
        setBusy(false);
      }
      return;
    }
    if (confirm === "no_show") {
      await run(() => Api.noShow(bill.id), () => t("bill.markedNoShow"));
    } else {
      await run(() => Api.cancelBooking(bill.id), () => t("bill.cancelled"));
    }
    setConfirm(null);
  };

  const footer = confirm ? (
    <>
      <span className="muted grow">
        {confirm === "no_show" ? t("bill.confirmNoShow") : confirm === "following" ? t("bill.confirmFollowing") : t("bill.confirmCancel")}
      </span>
      <button className="btn" onClick={() => setConfirm(null)} disabled={busy}>
        {t("common.keep")}
      </button>
      <button className="btn btn-danger" onClick={doCancel} disabled={busy}>
        {t("common.yes")}
      </button>
    </>
  ) : (
    <>
      {active && (
        <div className="foot-actions">
          <button className="btn btn-danger-ghost" onClick={() => setConfirm("cancel")}>
            {t("bill.cancel")}
          </button>
          {bill.series && (
            <button className="btn btn-danger-ghost" onClick={() => setConfirm("following")}>
              {t("bill.cancelFollowing")}
            </button>
          )}
          {canNoShow && (
            <button className="btn btn-ghost" onClick={() => setConfirm("no_show")}>
              {t("bill.noShow")}
            </button>
          )}
          {!bill.is_open && (
            <button className="btn btn-ghost" onClick={() => setView("edit")}>
              ✎ {t("bill.changeTime")}
            </button>
          )}
        </div>
      )}
      <span className="grow" />
      {!bill.is_open && (
        <button className="btn" onClick={() => setReceipt(true)}>
          🧾 {t("receipt.button")}
        </button>
      )}
      {active && bill.is_open ? (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(
              () => Api.stopOpenPlay(bill.id),
              (b) => t("bill.stopped", { name: b.customer_name, time: duration(Date.parse(b.end_at) - Date.parse(b.start_at)), price: money(b.price, club.currency) }),
            )
          }
        >
          ■ {t("bill.stop")}
        </button>
      ) : (
        <button className="btn btn-primary" onClick={close}>
          {t("common.done")}
        </button>
      )}
    </>
  );

  return (
    <Modal
      wide
      title={bill.customer_name}
      subtitle={
        <>
          {bill.court_name} · {longDate(dateIn(bill.start_at, club.timezone))} · {timeLabel}
          {bill.customer_phone && <> · {ltr(bill.customer_phone)}</>}
        </>
      }
      onClose={close}
      footer={footer}
    >
      <div className="chips">
        {bill.status !== "confirmed" && <span className="chip chip-off">{t(`status.${bill.status}`)}</span>}
        {bill.series && <span className="chip">↻ {t("bill.weekly")}</span>}
        {bill.status !== "cancelled" && <PaymentBadge booking={bill} />}
      </div>

      {bill.is_open && active && (
        <div className="live-panel">
          <span className="live-badge">
            <span className="live-dot" aria-hidden /> {t("bill.playingNow")}
          </span>
          <strong>{duration(now - started)}</strong>
          <span>{t("bill.byMinute")}</span>
        </div>
      )}

      {view === "menu" ? (
        <MenuPicker
          onPick={(product) =>
            run(() => Api.addItem(bill.id, product.id), () => t("bill.added", { name: product.name }))
          }
          onDone={() => setView("bill")}
          busy={busy}
        />
      ) : (
        <>
          <section className="bill">
            <div className="bill-line">
              <span>
                {t("bill.courtTime")}
                <small>{bill.is_open ? t("bill.running") : duration(Date.parse(bill.end_at) - started)}</small>
              </span>
              <strong>{bill.is_open ? "…" : money(bill.court_total, club.currency)}</strong>
            </div>
            {bill.items.map((item) => (
              <div key={item.id} className="bill-line">
                <span>
                  {item.name}
                  <small>
                    {money(item.unit_price, club.currency)} × {item.quantity}
                  </small>
                </span>
                {active && (
                  <span className="stepper">
                    <button
                      aria-label={t("bill.less")}
                      disabled={busy}
                      onClick={() => run(() => Api.setItemQuantity(bill.id, item.id, item.quantity - 1))}
                    >
                      −
                    </button>
                    <b>{item.quantity}</b>
                    <button
                      aria-label={t("bill.more")}
                      disabled={busy}
                      onClick={() => run(() => Api.setItemQuantity(bill.id, item.id, item.quantity + 1))}
                    >
                      +
                    </button>
                  </span>
                )}
                <strong>{money(item.total, club.currency)}</strong>
              </div>
            ))}
            {active && (
              <button className="add-line" onClick={() => setView("menu")}>
                ☕ {t("bill.addFromBuffet")}
              </button>
            )}
            {bill.discount_kind && (
              <div className="bill-line bill-discount">
                <span>
                  {discountLabel(bill.discount_kind, bill.discount_note, t)}
                  <small>
                    {bill.discount_fixed !== null
                      ? t("discount.fixedAmount")
                      : t(bill.discount_scope === "court" ? "discount.percentOfCourt" : "discount.percentOfBill", {
                          percent: Number(bill.discount_percent),
                        })}
                  </small>
                </span>
                {active && (
                  <button
                    className="icon-btn"
                    disabled={busy}
                    onClick={() => run(() => Api.removeDiscount(bill.id), () => t("discount.removed"))}
                    title={t("discount.remove")}
                    aria-label={t("discount.remove")}
                  >
                    ✕
                  </button>
                )}
                <strong>{minus(money(bill.discount, club.currency))}</strong>
              </div>
            )}
            {active && !bill.discount_kind && (
              <DiscountPanel
                bill={bill}
                busy={busy}
                onApply={(body, message) => run(() => Api.applyDiscount(bill.id, body), () => message)}
              />
            )}
            <div className="bill-total">
              <span>{t("bill.total")}</span>
              <strong>{bill.is_open ? `${money(bill.items_total, club.currency)} + …` : money(bill.total, club.currency)}</strong>
            </div>
            <div className="bill-sub">
              <span>{t("bill.paid")}</span>
              <span>{money(bill.paid_total, club.currency)}</span>
            </div>
            {Number(bill.refunded_total) > 0 && (
              <div className="bill-sub">
                <span>{t("refund.refunded")}</span>
                <span>{minus(money(bill.refunded_total, club.currency))}</span>
              </div>
            )}
            {!bill.is_open && bill.status !== "cancelled" && Number(bill.balance) > 0 && (
              <div className="bill-due">
                <span>{t("bill.due")}</span>
                <strong>{money(bill.balance, club.currency)}</strong>
              </div>
            )}

          </section>

          <Payments
            bill={bill}
            canRemove={canManage}
            busy={busy}
            onPay={(body) => run(() => Api.addPayment(bill.id, body), () => t("bill.paymentSaved"))}
            onRefund={(body) => run(() => Api.addRefund(bill.id, body), () => t("refund.saved"))}
            onRemove={(id) => run(() => Api.removePayment(bill.id, id))}
          />
          {canManage && <BookingHistory bookingId={bill.id} />}
        </>
      )}
      {error && <div className="alert">{error}</div>}
      {receipt && <ReceiptModal bill={bill} onClose={() => setReceipt(false)} />}
    </Modal>
  );
}

function Payments({
  bill,
  canRemove,
  busy,
  onPay,
  onRefund,
  onRemove,
}: {
  bill: BookingBill;
  canRemove: boolean;
  busy: boolean;
  onPay: (body: { amount: string; method: PaymentMethod; payer_name: string }) => Promise<unknown>;
  onRefund: (body: { amount: string; method: PaymentMethod; reason: string }) => Promise<unknown>;
  onRemove: (id: number) => void;
}) {
  const t = useT();
  const { club } = useClub();
  const balance = Number(bill.balance);
  const refundable = Number(bill.refundable);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [payer, setPayer] = useState("");
  const [received, setReceived] = useState("");
  const [refunding, setRefunding] = useState(false);

  // Suggest the full balance whenever it changes.
  useEffect(() => {
    setAmount(balance > 0 ? String(balance) : "");
    setReceived("");
  }, [balance]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onPay({ amount, method, payer_name: payer.trim() });
    if (ok) {
      setPayer("");
      setReceived("");
    }
  };

  const canPay = bill.status !== "cancelled" && (bill.is_open || balance > 0);
  // Payments and refunds in the order they happened.
  const rows = [
    ...bill.payments.map((p) => ({ key: `p${p.id}`, at: p.created_at, payment: p, refund: null })),
    ...bill.refunds.map((r) => ({ key: `r${r.id}`, at: r.created_at, payment: null, refund: r })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="payments">
      <h3>{t("bill.payments")}</h3>
      {rows.length === 0 && <p className="muted small">{t("bill.noPayments")}</p>}
      {rows.map(({ key, payment: p, refund: r }) =>
        p ? (
          <div key={key} className="payment-row">
            <span className={`method method-${p.method}`}>{t(`method.${p.method}`)}</span>
            <span className="grow">
              {p.payer_name || "—"}
              <small>
                {dateTime(p.created_at, club.timezone)}
                {p.created_by_name && ` · ${p.created_by_name}`}
              </small>
            </span>
            <strong>{money(p.amount, club.currency)}</strong>
            {canRemove && (
              <button className="icon-btn" onClick={() => onRemove(p.id)} disabled={busy} title={t("bill.removePayment")} aria-label={t("bill.removePayment")}>
                ✕
              </button>
            )}
          </div>
        ) : (
          r && (
            <div key={key} className="payment-row refund-row">
              <span className={`method method-${r.method}`}>↩ {t(`method.${r.method}`)}</span>
              <span className="grow">
                {r.reason ? t("refund.withReason", { reason: r.reason }) : t("refund.label")}
                <small>
                  {dateTime(r.created_at, club.timezone)}
                  {r.created_by_name && ` · ${r.created_by_name}`}
                </small>
              </span>
              <strong>{minus(money(r.amount, club.currency))}</strong>
            </div>
          )
        ),
      )}

      {refundable > 0 &&
        (refunding ? (
          <RefundForm
            refundable={refundable}
            busy={busy}
            onCancel={() => setRefunding(false)}
            methods={methodsFor(bill)}
            onSubmit={async (body) => {
              if (await onRefund(body)) setRefunding(false);
            }}
          />
        ) : (
          <div className="refund-due">
            <span>
              <strong>{t("refund.owed", { amount: money(refundable, club.currency) })}</strong>
              <small>{bill.status === "cancelled" ? t("refund.whyCancelled") : t("refund.whyOverpaid")}</small>
            </span>
            <button className="btn btn-small" onClick={() => setRefunding(true)}>
              ↩ {t("refund.give")}
            </button>
          </div>
        ))}

      {canPay && (
        <form className="pay-form" onSubmit={submit}>
          <div className="segmented">
            {methodsFor(bill).map((m) => (
              <button
                type="button"
                key={m}
                className={method === m ? "on" : ""}
                onClick={() => setMethod(m)}
                disabled={m === "balance" && Number(bill.customer_balance) <= 0}
              >
                {t(`method.${m}`)}
                {m === "balance" && <small>{money(bill.customer_balance ?? 0, club.currency)}</small>}
              </button>
            ))}
          </div>
          <div className="pay-inputs">
            <label className="field">
              <span>{t("bill.amount")}</span>
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </label>
            <label className="field">
              <span>{t("bill.payer")}</span>
              <input value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={120} placeholder={t("common.optional")} />
            </label>
          </div>
          {method === "cash" && <CashCalculator due={Number(amount) || 0} received={received} onChange={setReceived} />}
          {!bill.is_open && balance > 0 && (
            <div className="quick">
              <span className="muted small">{t("bill.split")}</span>
              {[2, 4].map((n) => (
                <button type="button" key={n} onClick={() => setAmount(String(Math.ceil(balance / n)))}>
                  ÷ {n}
                </button>
              ))}
              <button type="button" onClick={() => setAmount(String(balance))}>
                {t("bill.all")}
              </button>
            </div>
          )}
          <button className="btn btn-primary" disabled={busy || !amount}>
            {t("bill.takePayment", { amount: money(amount || 0, club.currency) })}
          </button>
        </form>
      )}
    </section>
  );
}

function RefundForm({
  refundable,
  methods,
  busy,
  onCancel,
  onSubmit,
}: {
  refundable: number;
  methods: PaymentMethod[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: { amount: string; method: PaymentMethod; reason: string }) => void;
}) {
  const t = useT();
  const { club } = useClub();
  const [amount, setAmount] = useState(String(refundable));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reason, setReason] = useState("");

  return (
    <form
      className="pay-form refund-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ amount, method, reason: reason.trim() });
      }}
    >
      <strong>↩ {t("refund.title")}</strong>
      <div className="segmented">
        {methods.map((m) => (
          <button type="button" key={m} className={method === m ? "on" : ""} onClick={() => setMethod(m)}>
            {t(`method.${m}`)}
          </button>
        ))}
      </div>
      <div className="pay-inputs">
        <label className="field">
          <span>{t("bill.amount")}</span>
          <input type="number" min="0.01" max={refundable} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t("refund.reason")}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={t("common.optional")} />
        </label>
      </div>
      <div className="discount-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          {t("common.close")}
        </button>
        <button className="btn btn-small btn-danger" disabled={busy || !amount}>
          {t("refund.confirm", { amount: money(amount || 0, club.currency) })}
        </button>
      </div>
    </form>
  );
}

/** What happened to this booking, for owners and managers. */
function BookingHistory({ bookingId }: { bookingId: number }) {
  const t = useT();
  const { club } = useClub();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Activity[] | null>(null);

  useEffect(() => {
    if (!open) return;
    Api.activity({ club: club.id, booking: bookingId })
      .then(setItems)
      .catch(() => setItems([]));
  }, [open, club.id, bookingId]);

  return (
    <section className="booking-history">
      <button className="link-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} {t("activity.forBooking")}
      </button>
      {open && items === null && <p className="muted small">{t("common.loading")}</p>}
      {open && items?.length === 0 && <p className="muted small">{t("activity.empty")}</p>}
      {open && items && items.length > 0 && <ActivityList items={items} compact />}
    </section>
  );
}

const QUICK_PERCENTS = [10, 20, 50, 100];

/** Loyalty offers the booking qualifies for, and a form for a manual discount. */
function DiscountPanel({
  bill,
  busy,
  onApply,
}: {
  bill: BookingBill;
  busy: boolean;
  onApply: (body: DiscountInput, message: string) => void;
}) {
  const t = useT();
  const { club } = useClub();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"court" | "total">("total");
  const [note, setNote] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: DiscountInput =
      mode === "percent"
        ? { kind: "manual", percent: value, scope, note: note.trim() }
        : { kind: "manual", amount: value, scope: "total", note: note.trim() };
    onApply(body, t("discount.applied"));
  };

  return (
    <div className="discount-panel">
      {bill.offers.map((offer) => (
        <div key={offer.kind} className="offer">
          <span className="offer-icon" aria-hidden>
            🎁
          </span>
          <span className="grow">
            <strong>{discountLabel(offer.kind, offer.note || String(offer.visit ?? ""), t)}</strong>
            <small>
              {t("discount.percentOfCourt", { percent: offer.percent })}
              {!bill.is_open && ` · ${minus(money(offer.amount, club.currency))}`}
            </small>
          </span>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy}
            onClick={() => onApply({ kind: offer.kind }, t("discount.applied"))}
          >
            {t("discount.apply")}
          </button>
        </div>
      ))}

      {!open ? (
        <button type="button" className="link-btn add-discount" onClick={() => setOpen(true)}>
          % {t("discount.add")}
        </button>
      ) : (
        <form className="discount-form" onSubmit={submit}>
          <div className="discount-row">
            <div className="segmented">
              <button type="button" className={mode === "percent" ? "on" : ""} onClick={() => setMode("percent")}>
                %
              </button>
              <button type="button" className={mode === "amount" ? "on" : ""} onClick={() => setMode("amount")}>
                {t("discount.amount")}
              </button>
            </div>
            <input
              type="number"
              min="0.01"
              max={mode === "percent" ? 100 : undefined}
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={mode === "percent" ? "10" : "500"}
              required
              aria-label={mode === "percent" ? t("discount.percent") : t("discount.amount")}
            />
          </div>
          {mode === "percent" && (
            <>
              <div className="quick">
                {QUICK_PERCENTS.map((p) => (
                  <button type="button" key={p} className={value === String(p) ? "on" : ""} onClick={() => setValue(String(p))}>
                    {p}%
                  </button>
                ))}
              </div>
              <div className="segmented">
                <button type="button" className={scope === "total" ? "on" : ""} onClick={() => setScope("total")}>
                  {t("discount.scopeTotal")}
                </button>
                <button type="button" className={scope === "court" ? "on" : ""} onClick={() => setScope("court")}>
                  {t("discount.scopeCourt")}
                </button>
              </div>
            </>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder={t("discount.reason")} />
          <div className="discount-actions">
            <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
              {t("common.close")}
            </button>
            <button className="btn btn-small btn-primary" disabled={busy || !value}>
              {t("discount.apply")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function MenuPicker({ onPick, onDone, busy }: { onPick: (p: Product) => void; onDone: () => void; busy: boolean }) {
  const t = useT();
  const { club } = useClub();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="menu-picker">
      <div className="card-head">
        <h3>{t("bill.addFromBuffet")}</h3>
        <button className="btn btn-small" onClick={onDone}>
          ← {t("bill.backToBill")}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {products?.length === 0 && <p className="muted">{t("menu.emptyHint")}</p>}
      {groups.map(([category, items]) => (
        <div key={category} className="menu-group">
          <h4>{category}</h4>
          <div className="menu-grid">
            {items.map((p) => (
              <button key={p.id} className="menu-tile" onClick={() => onPick(p)} disabled={busy}>
                <span>{p.name}</span>
                <strong>{money(p.price, club.currency)}</strong>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const ADJUST = [-30, -15, 15, 30, 60];

function EditTimeModal({
  bill,
  onClose,
  onSaved,
}: {
  bill: BookingBill;
  onClose: () => void;
  onSaved: (bill: BookingBill) => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const day = dateIn(bill.start_at, club.timezone);
  const [from, setFrom] = useState(() => clockTime(bill.start_at, club.timezone));
  const [to, setTo] = useState(() => clockTime(bill.end_at, club.timezone));
  const [name, setName] = useState(bill.customer_name);
  const [phone, setPhone] = useState(bill.customer_phone);
  const [quote, setQuote] = useState<{ price: string | null; error: string | null }>({ price: bill.price, error: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startIso = localIso(day, from, club.timezone, false);
  const endIso = localIso(day, to, club.timezone, true);
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / MINUTE);
  const oldMinutes = Math.round((Date.parse(bill.end_at) - Date.parse(bill.start_at)) / MINUTE);
  const timeChanged = Date.parse(startIso) !== Date.parse(bill.start_at) || Date.parse(endIso) !== Date.parse(bill.end_at);

  useEffect(() => {
    if (!from || !to) return;
    if (!(minutes > 0)) {
      setQuote({ price: null, error: t("error.end_before_start") });
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.quote(bill.court, startIso, endIso)
        .then((q) => !cancelled && setQuote({ price: q.price, error: null }))
        .catch((e) => !cancelled && setQuote({ price: null, error: errorText(e, t) }));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [bill.court, startIso, endIso, minutes, from, to, t]);

  const adjustEnd = (delta: number) => {
    const end = Math.max(Date.parse(endIso) + delta * MINUTE, Date.parse(startIso) + MINUTE);
    setTo(clockTime(new Date(end).toISOString(), club.timezone));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fresh = await Api.changeBooking(bill.id, {
        ...(timeChanged ? { start_at: startIso, end_at: endIso } : {}),
        customer_name: name.trim(),
        customer_phone: phone.trim(),
      });
      notify(t("bill.saved"));
      onSaved(fresh);
    } catch (err) {
      setBusy(false);
      setError(errorText(err, t));
    }
  };

  const diff = minutes - oldMinutes;

  return (
    <Modal
      title={t("bill.changeBooking")}
      subtitle={t("bill.was", {
        court: bill.court_name,
        time: timeRange(bill.start_at, bill.end_at, club.timezone),
        price: money(bill.price, club.currency),
      })}
      onClose={onClose}
      footer={
        <>
          <span className="total">
            {quote.price !== null ? money(quote.price, club.currency) : "—"}
            <small>
              {minutes > 0 ? duration(minutes * MINUTE) : ""}
              {timeChanged && minutes > 0 && diff !== 0 && ` (${diff > 0 ? "+" : "−"}${duration(Math.abs(diff) * MINUTE)})`}
            </small>
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.back")}
          </button>
          <button className="btn btn-primary" form="edit-booking" disabled={busy || quote.price === null || !name.trim()}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      <form id="edit-booking" onSubmit={submit} className="form">
        <div className="field-row">
          <label className="field">
            <span>{t("booking.from")}</span>
            <input type="time" step={60} value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            <span>{t("booking.until")}</span>
            <input type="time" step={60} value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
        </div>
        <div className="quick">
          {ADJUST.map((m) => (
            <button type="button" key={m} onClick={() => adjustEnd(m)}>
              <bdi>{m > 0 ? `+${m}` : `−${-m}`}</bdi> {t("booking.min")}
            </button>
          ))}
        </div>
        {quote.error && <p className="field-error">{quote.error}</p>}
        <label className="field">
          <span>{t("booking.customerName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>{t("booking.phone")}</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} inputMode="tel" dir="ltr" />
        </label>
        {timeChanged && <p className="hint">{t("bill.repriceHint")}</p>}
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
