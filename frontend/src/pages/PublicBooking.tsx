import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { PublicApi, type PublicAvailability, type PublicBooking as Booked, type PublicClub } from "../api";
import { CourtArt, Logo } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { addDays, clockTime, dateIn, dateTime, longDate, ltr, money, timeRange, weekdayNames } from "../format";
import { errorText, useT } from "../i18n";

const DURATIONS = [60, 90, 120];

interface Option {
  courtId: number;
  courtName: string;
  start: string;
  end: string;
  price: number;
}

/** Start times on each court where `minutes` of free, priced slots follow each other. */
function options(availability: PublicAvailability, slotMinutes: number, minutes: number): Option[] {
  const count = minutes / slotMinutes;
  const out: Option[] = [];
  for (const court of availability.courts) {
    for (let i = 0; i + count <= court.slots.length; i++) {
      const run = court.slots.slice(i, i + count);
      const free = run.every((s, k) => s.available && s.price !== null && (k === 0 || run[k - 1].end === s.start));
      if (free) {
        out.push({
          courtId: court.id,
          courtName: court.name,
          start: run[0].start,
          end: run[run.length - 1].end,
          price: run.reduce((sum, s) => sum + Number(s.price), 0),
        });
      }
    }
  }
  return out;
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
        if (c.slot_minutes === 60) setMinutes(60);
      })
      .catch(() => setMissing(true));
  }, [slug]);

  useEffect(() => {
    if (!club || !date) return;
    setAvailability(null);
    setChoice(null);
    PublicApi.availability(slug, date)
      .then(setAvailability)
      .catch((e) => setError(errorText(e, t)));
  }, [club, slug, date, t]);

  const days = useMemo(
    () => (club ? Array.from({ length: club.days_ahead + 1 }, (_, i) => addDays(club.today, i)) : []),
    [club],
  );
  const names = weekdayNames();
  const found = useMemo(
    () => (availability && club ? options(availability, club.slot_minutes, minutes) : []),
    [availability, club, minutes],
  );
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
        <div className="segmented">
          {DURATIONS.filter((m) => m % club.slot_minutes === 0).map((m) => (
            <button key={m} className={m === minutes ? "on" : ""} onClick={() => setMinutes(m)}>
              {m} {t("booking.min")}
            </button>
          ))}
        </div>

        <h2 className="step">3 · {t("public.pickTime", { date: longDate(date) })}</h2>
        {!availability && <p className="muted">{t("common.loading")}</p>}
        {availability && found.length === 0 && <p className="muted">{t("public.noTimes")}</p>}
        {byCourt.map(([court, list]) => (
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

      {choice && <BookForm club={club} choice={choice} onBooked={setBooked} />}
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onBooked(
        await PublicApi.book(club.slug, {
          court: choice.courtId,
          start_at: choice.start,
          end_at: choice.end,
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          consent,
        }),
      );
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
          {busy ? t("common.saving") : t("public.book", { price: money(choice.price, club.currency) })}
        </button>
        <p className="hint">{t("public.payAtClub")}</p>
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

  const cancel = async () => {
    try {
      onChanged?.(await PublicApi.cancel(booked.token));
      setConfirming(false);
    } catch (err) {
      setError(errorText(err, t));
    }
  };

  return (
    <section className={`card booked${cancelled ? " is-cancelled" : ""}`}>
      <div className="booked-icon" aria-hidden>
        {cancelled ? "✕" : "✓"}
      </div>
      <h1>{cancelled ? t("public.cancelledTitle") : t("public.bookedTitle")}</h1>
      <div className="public-choice">
        <span>
          <strong>
            {booked.club} · {booked.court}
          </strong>
          {longDate(dateIn(booked.start_at, booked.timezone))} · {timeRange(booked.start_at, booked.end_at, booked.timezone)}
          <small>{booked.customer_name}</small>
        </span>
        <strong className="price">{money(booked.price, booked.currency)}</strong>
      </div>
      {!cancelled && (
        <>
          {booked.telegram_link && (
            <a className="btn btn-telegram btn-block" href={booked.telegram_link} target="_blank" rel="noreferrer">
              ✈ {t("public.telegram")}
            </a>
          )}
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
          {booked.can_cancel ? (
            confirming ? (
              <div className="confirm-row">
                <span>{t("bill.confirmCancel")}</span>
                <button className="btn" onClick={() => setConfirming(false)}>
                  {t("common.keep")}
                </button>
                <button className="btn btn-danger" onClick={cancel}>
                  {t("common.yes")}
                </button>
              </div>
            ) : (
              <button className="btn btn-danger-ghost" onClick={() => setConfirming(true)}>
                {t("public.cancel", { until: ltr(dateTime(booked.cancel_until, booked.timezone)) })}
              </button>
            )
          ) : (
            <p className="note">{t("public.tooLate")}</p>
          )}
        </>
      )}
      {error && <div className="alert">{error}</div>}
      <Link className="link-btn" to={`/book/${booked.club_slug}`}>
        ← {t("public.another")}
      </Link>
    </section>
  );
}

/** /b/:token — the customer's private link to their booking. */
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
