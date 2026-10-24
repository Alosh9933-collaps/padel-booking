import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { PublicApi, type DemoPayment, type PublicAvailability, type PublicBooking as Booked, type PublicClub } from "../api";
import { CourtArt, Logo } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { addDays, clockTime, dateIn, dateTime, duration, isolate, longDate, ltr, money, timeRange, weekdayNames } from "../format";
import { errorText, useT } from "../i18n";

interface Option {
  courtId: number;
  courtName: string;
  start: string;
  end: string;
  price: number;
}

function options(availability: PublicAvailability): Option[] {
  return availability.courts.flatMap((court) =>
    court.times.map((time) => ({ courtId: court.id, courtName: court.name, start: time.start, end: time.end, price: Number(time.price) })),
  );
}

function validLength(club: PublicClub, minutes: number) {
  return Number.isInteger(minutes) && minutes >= club.min_minutes && minutes <= club.max_minutes && minutes % club.step_minutes === 0;
}

/** Any length the club allows: typed in, or stepped up and down. */
function LengthPicker({ club, value, onChange }: { club: PublicClub; value: string; onChange: (value: string) => void }) {
  const t = useT();
  const minutes = Number(value);
  const valid = validLength(club, minutes);
  const step = (delta: number) => {
    const base = minutes > 0 ? Math.round(minutes / club.step_minutes) * club.step_minutes : club.min_minutes;
    onChange(String(Math.min(club.max_minutes, Math.max(club.min_minutes, base + delta))));
  };
  return (
    <>
      <div className="length-picker">
        <button
          type="button"
          className="btn"
          onClick={() => step(-club.step_minutes)}
          disabled={valid && minutes <= club.min_minutes}
          aria-label={t("public.lessTime", { step: club.step_minutes })}
        >
          −
        </button>
        <label className="length-field">
          <input
            type="number"
            inputMode="numeric"
            min={club.min_minutes}
            max={club.max_minutes}
            step={club.step_minutes}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={t("public.pickLength")}
            aria-invalid={!valid}
          />
          <span>{t("booking.min")}</span>
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => step(club.step_minutes)}
          disabled={valid && minutes >= club.max_minutes}
          aria-label={t("public.moreTime", { step: club.step_minutes })}
        >
          +
        </button>
        {valid && <span className="length-total">= {duration(minutes * 60_000)}</span>}
      </div>
      <p className={`hint length-hint${valid ? "" : " is-bad"}`}>
        {t("public.lengthHint", { min: club.min_minutes, max: club.max_minutes, step: club.step_minutes })}
      </p>
    </>
  );
}

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="public">
      <header className="public-bar">
        <Logo size={34} light />
        {title && <strong className="public-club">{title}</strong>}
        <LanguageSwitch dark />
      </header>
      <main className="public-main">{children}</main>
    </div>
  );
}

/** /book/:slug — customers book a court themselves. */
export function PublicBookingPage() {
  const t = useT();
  const { slug = "" } = useParams();
  const [club, setClub] = useState<PublicClub | null>(null);
  const [date, setDate] = useState("");
  // What the customer typed, and the last valid length the free times are for.
  const [draft, setDraft] = useState("90");
  const [minutes, setMinutes] = useState(90);
  const [availability, setAvailability] = useState<PublicAvailability | null>(null);
  const [choice, setChoice] = useState<Option | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    PublicApi.club(slug)
      .then((c) => {
        setClub(c);
        setDate(c.today);
      })
      .catch(() => setMissing(true));
  }, [slug]);

  // Wait until the customer stops typing before asking for times.
  useEffect(() => {
    const typed = Number(draft);
    if (!club || !validLength(club, typed)) return;
    const timer = window.setTimeout(() => setMinutes(typed), 350);
    return () => window.clearTimeout(timer);
  }, [club, draft]);

  useEffect(() => {
    if (!club || !date) return;
    setAvailability(null);
    setChoice(null);
    setError(null);
    PublicApi.availability(slug, date, minutes)
      .then(setAvailability)
      .catch((e) => setError(errorText(e, t)));
  }, [club, slug, date, minutes, t]);

  const days = useMemo(
    () => (club ? Array.from({ length: club.days_ahead + 1 }, (_, i) => addDays(club.today, i)) : []),
    [club],
  );
  const names = weekdayNames();
  const found = useMemo(() => (availability ? options(availability) : []), [availability]);
  const byCourt = useMemo(() => {
    const map = new Map<string, Option[]>();
    for (const o of found) map.set(o.courtName, [...(map.get(o.courtName) ?? []), o]);
    return [...map.entries()];
  }, [found]);

  if (missing) {
    return (
      <Frame>
        <div className="card empty">
          <h3>{t("public.notFound")}</h3>
          <p className="muted">{t("public.notFoundHint")}</p>
        </div>
      </Frame>
    );
  }
  if (!club) return <Frame>{null}</Frame>;

  if (booked) return <Frame title={club.name}><BookedCard booked={booked} /></Frame>;

  // Times show once they match the length typed in; an invalid length only shows the hint.
  const typedValid = validLength(club, Number(draft));
  const ready = typedValid && Number(draft) === minutes && availability !== null;

  return (
    <Frame title={club.name}>
      <section className="public-hero">
        <div>
          <h1>{t("public.title", { club: club.name })}</h1>
          <p>{t("public.subtitle", { days: club.days_ahead, hours: club.cancel_hours })}</p>
        </div>
        <CourtArt className="public-court" />
      </section>

      <section className="card">
        <h2 className="step">1 · {t("public.pickDay")}</h2>
        <div className="day-strip" role="list">
          {days.map((d) => {
            const weekday = names[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7];
            return (
              <button key={d} className={d === date ? "on" : ""} onClick={() => setDate(d)} role="listitem">
                <small>{d === club.today ? t("schedule.today") : weekday}</small>
                <strong>{Number(d.slice(8))}</strong>
              </button>
            );
          })}
        </div>

        <h2 className="step">2 · {t("public.pickLength")}</h2>
        <LengthPicker club={club} value={draft} onChange={setDraft} />

        <h2 className="step">3 · {t("public.pickTime", { date: longDate(date) })}</h2>
        {typedValid && !ready && <p className="muted">{t("common.loading")}</p>}
        {ready && found.length === 0 && <p className="muted">{t("public.noTimes")}</p>}
        {ready && byCourt.map(([court, list]) => (
          <div key={court} className="time-group">
            <h3>{court}</h3>
            <div className="time-grid">
              {list.map((o) => (
                <button
                  key={o.start}
                  className={choice?.start === o.start && choice.courtId === o.courtId ? "on" : ""}
                  onClick={() => setChoice(o)}
                >
                  <strong>{clockTime(o.start, club.timezone)}</strong>
                  <small>{money(o.price, club.currency)}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      {choice && ready && <BookForm club={club} choice={choice} onBooked={setBooked} />}
      {error && <div className="alert">{error}</div>}
    </Frame>
  );
}

function BookForm({ club, choice, onBooked }: { club: PublicClub; choice: Option; onBooked: (b: Booked) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What is paid now; the server works out the exact amount the same way.
  const prepay = Math.round(choice.price * club.prepay_percent) / 100;
  const rest = choice.price - prepay;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const booked = await PublicApi.book(club.slug, {
        court: choice.courtId,
        start_at: choice.start,
        end_at: choice.end,
        customer_name: name.trim(),
        customer_phone: phone.trim(),
        consent,
      });
      // The court is held while the customer pays on the payment page, which brings them back to /b/<token>.
      if (booked.awaiting_payment && booked.payment_url) window.location.assign(booked.payment_url);
      else onBooked(booked);
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <section className="card public-form">
      <h2 className="step">4 · {t("public.yourDetails")}</h2>
      <div className="public-choice">
        <span>
          <strong>{choice.courtName}</strong>
          {longDate(dateIn(choice.start, club.timezone))} · {timeRange(choice.start, choice.end, club.timezone)}
        </span>
        <strong className="price">{money(choice.price, club.currency)}</strong>
      </div>
      <form className="form" onSubmit={submit}>
        <div className="field-row">
          <label className="field">
            <span>{t("booking.customerName")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" />
          </label>
          <label className="field">
            <span>{t("booking.phone")}</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={32} inputMode="tel" autoComplete="tel" dir="ltr" />
          </label>
        </div>
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
          <span>{t("public.consent", { club: club.name })}</span>
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !consent}>
          {busy
            ? t("common.saving")
            : prepay > 0
              ? t("public.payAndBook", { price: money(prepay, club.currency) })
              : t("public.book", { price: money(choice.price, club.currency) })}
        </button>
        <p className="hint">
          {prepay <= 0
            ? t("public.payAtClub")
            : rest > 0
              ? t("public.prepayPart", { minutes: club.hold_minutes, rest: money(rest, club.currency) })
              : t("public.prepayFull", { minutes: club.hold_minutes })}
        </p>
      </form>
    </section>
  );
}

function BookedCard({ booked, onChanged }: { booked: Booked; onChanged?: (b: Booked) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/b/${booked.token}`;
  const cancelled = booked.status === "cancelled";
  const awaiting = booked.awaiting_payment;
  const prepaid = Number(booked.prepaid);
  const refunded = Number(booked.refunded);
  const cur = (v: string | number) => money(v, booked.currency);

  const cancel = async () => {
    try {
      onChanged?.(await PublicApi.cancel(booked.token));
      setConfirming(false);
    } catch (err) {
      setError(errorText(err, t));
    }
  };

  const heading = awaiting
    ? t("public.awaitingTitle")
    : booked.payment_missed
      ? t("public.missedTitle")
      : cancelled
        ? t("public.cancelledTitle")
        : t("public.bookedTitle");

  return (
    <section className={`card booked${cancelled ? " is-cancelled" : ""}${awaiting ? " is-awaiting" : ""}`}>
      <div className="booked-icon" aria-hidden>
        {awaiting ? "⏳" : cancelled ? "✕" : "✓"}
      </div>
      <h1>{heading}</h1>
      <div className="public-choice">
        <span>
          <strong>
            {booked.club} · {booked.court}
          </strong>
          {longDate(dateIn(booked.start_at, booked.timezone))} · {timeRange(booked.start_at, booked.end_at, booked.timezone)}
          <small>{booked.customer_name}</small>
        </span>
        <strong className="price">{cur(booked.price)}</strong>
      </div>

      {awaiting && booked.payment_url && booked.prepay_amount && (
        <>
          <p className="note">
            {t("public.awaitingHint", { time: ltr(clockTime(booked.hold_until ?? booked.start_at, booked.timezone)) })}
          </p>
          <a className="btn btn-primary btn-block" href={booked.payment_url}>
            {t("public.payNow", { price: cur(booked.prepay_amount) })}
          </a>
        </>
      )}
      {booked.payment_missed && <p className="note">{t("public.missedHint")}</p>}
      {!cancelled && !awaiting && prepaid > 0 && (
        <p className="paid-line">
          ✓ {t("public.prepaid", { amount: cur(prepaid) })}
          {Number(booked.price) > prepaid && ` · ${t("public.restAtClub", { amount: cur(Number(booked.price) - prepaid) })}`}
        </p>
      )}
      {cancelled && refunded > 0 && <p className="paid-line">↩ {t("public.refunded", { amount: cur(refunded) })}</p>}

      {!cancelled && (
        <>
          {!awaiting && booked.telegram_link && (
            <a className="btn btn-telegram btn-block" href={booked.telegram_link} target="_blank" rel="noreferrer">
              ✈ {t("public.telegram")}
            </a>
          )}
          {!awaiting && (
            <>
              <div className="public-link">
                <code dir="ltr">{link}</code>
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? `✓ ${t("receipt.copied")}` : t("receipt.copy")}
                </button>
              </div>
              <p className="hint">{t("public.keepLink")}</p>
            </>
          )}
          {awaiting || booked.can_cancel ? (
            confirming ? (
              <div className="confirm-row">
                <span>{awaiting ? t("public.confirmGiveUp") : t("bill.confirmCancel")}</span>
                <button className="btn" onClick={() => setConfirming(false)}>
                  {t("common.keep")}
                </button>
                <button className="btn btn-danger" onClick={cancel}>
                  {t("common.yes")}
                </button>
              </div>
            ) : (
              <button className="btn btn-danger-ghost" onClick={() => setConfirming(true)}>
                {awaiting
                  ? t("public.giveUp")
                  : // A whole date in the reader's language keeps its own order: isolate it, never force LTR.
                    t("public.cancel", { until: isolate(dateTime(booked.cancel_until, booked.timezone)) })}
              </button>
            )
          ) : (
            <p className="note">{t("public.tooLate")}</p>
          )}
          {!awaiting && prepaid > 0 && booked.can_cancel && <p className="hint">{t("public.refundOnCancel")}</p>}
        </>
      )}
      {error && <div className="alert">{error}</div>}
      <Link className="link-btn" to={`/book/${booked.club_slug}`}>
        ← {t("public.another")}
      </Link>
    </section>
  );
}

/** /b/:token — the customer's private link to their booking. Payment pages send them back here. */
export function PublicBookingLink() {
  const t = useT();
  const { token = "" } = useParams();
  const [booked, setBooked] = useState<Booked | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    PublicApi.booking(token)
      .then(setBooked)
      .catch(() => setMissing(true));
  }, [token]);

  // Coming back from paying, the provider may need a few seconds to confirm.
  const awaiting = booked?.awaiting_payment ?? false;
  useEffect(() => {
    if (!awaiting) return;
    const timer = window.setInterval(() => {
      PublicApi.booking(token)
        .then(setBooked)
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [awaiting, token]);

  if (missing) {
    return (
      <Frame>
        <div className="card empty">
          <h3>{t("public.linkNotFound")}</h3>
        </div>
      </Frame>
    );
  }
  return <Frame title={booked?.club}>{booked && <BookedCard booked={booked} onChanged={setBooked} />}</Frame>;
}

/** /pay/demo/:id — the demo provider's payment page, for trying online booking without real money. */
export function DemoPaymentPage() {
  const t = useT();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [payment, setPayment] = useState<DemoPayment | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    PublicApi.demoPayment(id)
      .then(setPayment)
      .catch(() => setMissing(true));
  }, [id]);

  const finish = async (result: "succeeded" | "canceled") => {
    setBusy(true);
    setError(null);
    try {
      const done = await PublicApi.demoPay(id, result);
      navigate(done.return_url);
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <Frame>
        <div className="card empty">
          <h3>{t("public.linkNotFound")}</h3>
        </div>
      </Frame>
    );
  }
  if (!payment) return <Frame>{null}</Frame>;
  return (
    <Frame title={payment.club}>
      <section className="card demo-pay">
        <span className="demo-badge">{t("demoPay.badge")}</span>
        <h1>{t("demoPay.title")}</h1>
        <p className="muted">{t("demoPay.hint")}</p>
        <div className="demo-card" aria-hidden>
          <span>•••• •••• •••• 4242</span>
          <span>12/30</span>
        </div>
        <div className="public-choice">
          <span>
            <strong>{payment.club}</strong>
            {t("demoPay.prepayment")}
          </span>
          <strong className="price">{money(payment.amount, payment.currency)}</strong>
        </div>
        {payment.status === "pending" ? (
          <>
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => finish("succeeded")}>
              {t("demoPay.pay", { price: money(payment.amount, payment.currency) })}
            </button>
            <button className="btn btn-block" disabled={busy} onClick={() => finish("canceled")}>
              {t("demoPay.cancel")}
            </button>
          </>
        ) : (
          <Link className="btn btn-block" to={payment.return_url}>
            {t("demoPay.back")}
          </Link>
        )}
        {error && <div className="alert">{error}</div>}
      </section>
    </Frame>
  );
}
