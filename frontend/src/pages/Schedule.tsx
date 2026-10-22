import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Api, type Booking, type Court, type Slot, type WeeklyWeek } from "../api";
import { BillModal, localIso } from "../components/Bill";
import { CustomerFields } from "../components/CustomerField";
import { Modal } from "../components/Modal";
import { addDays, clockTime, dateIn, ltr, duration, longDate, money, shortDate, timeRange, todayIn } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";

const ROW_HEIGHT = 34;
const MINUTE = 60_000;

interface DayData {
  courts: Court[];
  slots: Record<number, Slot[]>;
  bookings: Booking[];
}

/** Rows of the board: the club's slot grid, used only to draw the day. */
interface Timeline {
  rows: Slot[];
  start: number;
  end: number;
  slotMs: number;
}

function timelineOf(rows: Slot[]): Timeline | null {
  if (!rows.length) return null;
  const start = Date.parse(rows[0].start);
  return {
    rows,
    start,
    end: Date.parse(rows[rows.length - 1].end),
    slotMs: Date.parse(rows[0].end) - start,
  };
}

function y(t: Timeline, ms: number) {
  return ((ms - t.start) / t.slotMs) * ROW_HEIGHT;
}

/** Where a booking ends on the board. Running open play ends "now". */
function shownEnd(b: Booking, now: number) {
  return b.is_open
    ? Math.min(Math.max(now, Date.parse(b.start_at) + MINUTE), Date.parse(b.end_at))
    : Date.parse(b.end_at);
}

export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function Schedule() {
  const t = useT();
  const { club } = useClub();
  const [date, setDate] = useState(() => todayIn(club.timezone));
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<{ court: Court; start: number } | null>(null);
  const [openPlayCourt, setOpenPlayCourt] = useState<Court | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const courts = (await Api.courts()).filter((c) => c.club === club.id && c.is_active);
        const [availability, bookings] = await Promise.all([
          Promise.all(courts.map((c) => Api.availability(c.id, date))),
          Api.bookings({ date, status: "confirmed" }),
        ]);
        if (cancelled) return;
        const ids = new Set(courts.map((c) => c.id));
        setData({
          courts,
          slots: Object.fromEntries(availability.map((a) => [a.court, a.slots])),
          bookings: bookings.filter((b) => ids.has(b.court)),
        });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errorText(e, t));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [club.id, date, version, t]);

  const reload = () => setVersion((v) => v + 1);
  const today = todayIn(club.timezone);
  const timeline = data && data.courts.length ? timelineOf(data.slots[data.courts[0].id] ?? []) : null;
  const dayIsOver = timeline !== null && timeline.end - MINUTE <= now;
  const clubIsOpenNow =
    timeline !== null && date === today && now >= timeline.start && now < timeline.end - MINUTE;

  const stats = useMemo(() => {
    if (!data || !timeline) return null;
    const courtMs = (timeline.end - timeline.start) * data.courts.length;
    const bookedMs = data.bookings.reduce(
      (sum, b) =>
        sum +
        Math.max(0, Math.min(shownEnd(b, now), timeline.end) - Math.max(Date.parse(b.start_at), timeline.start)),
      0,
    );
    return {
      count: data.bookings.length,
      live: data.bookings.filter((b) => b.is_open).length,
      revenue: data.bookings.reduce((sum, b) => sum + Number(b.total), 0),
      due: data.bookings.reduce((sum, b) => sum + (b.is_open ? 0 : Math.max(0, Number(b.balance))), 0),
      occupancy: courtMs ? Math.round((bookedMs / courtMs) * 100) : 0,
    };
  }, [data, timeline, now]);

  const pick = (court: Court, slot: Slot) => {
    let start = Math.max(Date.parse(slot.start), Math.ceil(now / MINUTE) * MINUTE);
    // Clicking the free tail of a slot starts right after the booking before it.
    const before = data?.bookings.find(
      (b) => b.court === court.id && Date.parse(b.start_at) <= start && shownEnd(b, now) > start,
    );
    if (before) start = Date.parse(before.end_at);
    setPicked({ court, start });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{t("nav.schedule")}</p>
          <h1>{longDate(date)}</h1>
        </div>
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))} aria-label={t("schedule.prevDay")}>
            <span className="flip">‹</span>
          </button>
          <button className="btn" onClick={() => setDate(today)} disabled={date === today}>
            {t("schedule.today")}
          </button>
          <input
            type="date"
            className="date-input"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            aria-label={t("schedule.date")}
          />
          <button className="btn" onClick={() => setDate(addDays(date, 1))} aria-label={t("schedule.nextDay")}>
            <span className="flip">›</span>
          </button>
        </div>
      </header>

      {stats && (
        <div className="stat-row">
          <StatTile label={t("schedule.bookings")} value={String(stats.count)}>
            {stats.live > 0 && <span className="stat-sub live-sub">● {t("schedule.playingNow", { count: stats.live })}</span>}
          </StatTile>
          <StatTile label={t("schedule.billed")} value={money(stats.revenue, club.currency)}>
            {stats.due > 0 && <span className="stat-sub due-sub">{t("schedule.stillDue", { amount: money(stats.due, club.currency) })}</span>}
          </StatTile>
          <StatTile label={t("schedule.occupancy")} value={`${stats.occupancy}%`}>
            <div className="meter" aria-hidden>
              <span style={{ width: `${stats.occupancy}%` }} />
            </div>
          </StatTile>
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {dayIsOver && (
        <div className="banner">
          <span>{date === today ? t("schedule.todayOver") : t("schedule.dayPast")}</span>
          <button className="btn btn-primary btn-small" onClick={() => setDate(addDays(today, 1))}>
            {t("schedule.goTomorrow")}
          </button>
        </div>
      )}

      {data && data.courts.length === 0 && (
        <div className="card empty">
          <h3>{t("schedule.noCourts")}</h3>
          <p className="muted">{t("schedule.noCourtsHint")}</p>
        </div>
      )}

      {data && timeline && (
        <>
          <div className="legend">
            <span><i className="sw sw-free" /> {t("schedule.legendFree")}</span>
            <span><i className="sw sw-booked" /> {t("schedule.legendBooked")}</span>
            <span><i className="sw sw-live" /> {t("schedule.legendLive")}</span>
            <span><i className="sw sw-due" /> {t("schedule.legendDue")}</span>
            <span><i className="sw sw-closed" /> {t("schedule.legendClosed")}</span>
          </div>
          <div className={`board-wrap${loading ? " is-loading" : ""}`}>
            <div
              className="board"
              style={{ gridTemplateColumns: `64px repeat(${data.courts.length}, minmax(170px, 1fr))` }}
            >
              <div className="board-corner" />
              {data.courts.map((court) => (
                <div key={court.id} className="board-court">
                  <div>
                    <strong>{court.name}</strong>
                    <span>{t(`courts.${court.kind}`)}</span>
                  </div>
                  {clubIsOpenNow && (
                    <button className="open-play-btn" onClick={() => setOpenPlayCourt(court)} title={t("openPlay.title")}>
                      ▶ {t("openPlay.button")}
                    </button>
                  )}
                </div>
              ))}

              <div className="board-times" style={{ height: timeline.rows.length * ROW_HEIGHT }}>
                {timeline.rows.map((slot, i) => {
                  const label = clockTime(slot.start, club.timezone);
                  return (
                    <span key={slot.start} className={label.endsWith(":00") ? "full" : ""} style={{ top: i * ROW_HEIGHT }}>
                      {label}
                    </span>
                  );
                })}
              </div>
              {data.courts.map((court) => (
                <CourtColumn
                  key={court.id}
                  court={court}
                  timeline={timeline}
                  slots={data.slots[court.id] ?? []}
                  bookings={data.bookings.filter((b) => b.court === court.id)}
                  now={now}
                  onPick={(slot) => pick(court, slot)}
                  onOpen={(b) => setOpened(b.id)}
                />
              ))}
              {date === today && now > timeline.start && now < timeline.end && (
                <div className="now-line" style={{ top: `calc(var(--board-head) + ${y(timeline, now)}px)` }} aria-hidden>
                  <span>{clockTime(new Date(now).toISOString(), club.timezone)}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {picked && timeline && (
        <NewBookingModal
          court={picked.court}
          date={date}
          start={picked.start}
          dayEnd={timeline.end}
          onClose={() => setPicked(null)}
          onDone={() => {
            setPicked(null);
            reload();
          }}
        />
      )}
      {openPlayCourt && (
        <OpenPlayModal
          court={openPlayCourt}
          now={now}
          onClose={() => setOpenPlayCourt(null)}
          onDone={() => {
            setOpenPlayCourt(null);
            reload();
          }}
        />
      )}
      {opened !== null && (
        <BillModal
          bookingId={opened}
          now={now}
          onClose={() => setOpened(null)}
          onChanged={() => {
            setOpened(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function CourtColumn({
  court,
  timeline,
  slots,
  bookings,
  now,
  onPick,
  onOpen,
}: {
  court: Court;
  timeline: Timeline;
  slots: Slot[];
  bookings: Booking[];
  now: number;
  onPick: (slot: Slot) => void;
  onOpen: (booking: Booking) => void;
}) {
  const t = useT();
  const { club } = useClub();
  return (
    <div className="board-col" style={{ height: timeline.rows.length * ROW_HEIGHT }}>
      {slots.map((slot, i) => {
        const open = slot.price !== null && Date.parse(slot.end) - MINUTE > now;
        const style = { top: i * ROW_HEIGHT, height: ROW_HEIGHT - 2 };
        if (!open) {
          return (
            <div key={slot.start} className="cell cell-closed" style={style} title={slot.price === null ? t("schedule.noPrice") : undefined}>
              —
            </div>
          );
        }
        return (
          <button
            key={slot.start}
            className="cell cell-free"
            style={style}
            onClick={() => onPick(slot)}
            aria-label={t("schedule.bookAt", { court: court.name, time: clockTime(slot.start, club.timezone) })}
          >
            <span className="cell-price">{money(slot.price, club.currency)}</span>
            <span className="cell-plus">+ {t("schedule.book")}</span>
          </button>
        );
      })}

      {bookings.map((b) => {
        const start = Math.max(Date.parse(b.start_at), timeline.start);
        const end = Math.min(shownEnd(b, now), timeline.end);
        const hold = Math.min(Date.parse(b.end_at), timeline.end);
        const top = y(timeline, start);
        const height = Math.max(y(timeline, end) - top, 20);
        const tall = height >= ROW_HEIGHT * 1.6;
        const due = !b.is_open && b.payment_status !== "paid";
        return (
          <div key={b.id}>
            {b.is_open && hold > end && (
              <button
                className="booking-hold"
                style={{ top: top + height, height: y(timeline, hold) - top - height }}
                onClick={() => onOpen(b)}
                title={t("schedule.heldTitle")}
              >
                <span>{t("schedule.held")}</span>
              </button>
            )}
            <button
              className={`booking${b.is_open ? " is-live" : ""}${!b.is_open && end <= now ? " is-past" : ""}${due ? " is-due" : ""}`}
              style={{ top, height }}
              onClick={() => onOpen(b)}
            >
              <strong>
                {b.is_open && <span className="live-dot" aria-hidden />}
                {b.series && <span aria-label={t("bill.weekly")}>↻</span>}
                {b.customer_name}
              </strong>
              {(tall || b.is_open) && (
                <span>
                  {b.is_open
                    ? `${t("bill.since", { time: clockTime(b.start_at, club.timezone) })} · ${duration(now - Date.parse(b.start_at))}`
                    : timeRange(b.start_at, b.end_at, club.timezone)}
                </span>
              )}
              {tall && !b.is_open && (
                <span className="cell-price">
                  {money(b.total, club.currency)}
                  {due && <em>{t(`pay.${b.payment_status}`)}</em>}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function StatTile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {children}
    </div>
  );
}

const QUICK = [60, 90, 120];

function NewBookingModal({
  court,
  date,
  start,
  dayEnd,
  onClose,
  onDone,
}: {
  court: Court;
  date: string;
  start: number;
  dayEnd: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const hhmm = (ms: number) => clockTime(new Date(ms).toISOString(), club.timezone);
  const [from, setFrom] = useState(() => hhmm(start));
  const [to, setTo] = useState(() => hhmm(Math.min(start + 60 * MINUTE, dayEnd)));
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [weeks, setWeeks] = useState(8);
  const [plan, setPlan] = useState<WeeklyWeek[] | null>(null);
  const [quote, setQuote] = useState<{ price: string | null; error: string | null }>({ price: null, error: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startIso = localIso(date, from, club.timezone, false);
  const endIso = localIso(date, to, club.timezone, true);
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / MINUTE);

  useEffect(() => {
    setPlan(null);
    if (!from || !to) return;
    if (!(minutes > 0)) {
      setQuote({ price: null, error: t("error.end_before_start") });
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.quote(court.id, startIso, endIso)
        .then((q) => !cancelled && setQuote({ price: q.price, error: null }))
        .catch((e) => !cancelled && setQuote({ price: null, error: errorText(e, t) }));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [court.id, startIso, endIso, minutes, from, to, t]);

  useEffect(() => setPlan(null), [weeks, repeat]);

  const setLength = (length: number) => setTo(hhmm(Math.min(Date.parse(startIso) + length * MINUTE, dayEnd)));

  const body = () => ({
    court: court.id,
    start_at: startIso,
    end_at: endIso,
    customer_name: name.trim(),
    customer_phone: phone.trim(),
  });

  const checkWeeks = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await Api.weekly({ ...body(), customer_name: name.trim() || "-", weeks, dry_run: true });
      setPlan(result.skipped);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (repeat) {
        const result = await Api.weekly({ ...body(), weeks, dry_run: false });
        notify(t("booking.weeklyDone", { booked: result.created.length, total: weeks }));
      } else {
        await Api.createBooking(body());
        notify(t("booking.done", { court: court.name, name: name.trim(), time: ltr(`${from}–${to}`) }));
      }
      onDone();
    } catch (err) {
      setBusy(false);
      setError(errorText(err, t));
    }
  };

  const freeWeeks = plan?.filter((w) => w.ok).length ?? 0;

  return (
    <Modal
      title={t("booking.new")}
      subtitle={`${court.name} · ${longDate(date)}`}
      onClose={onClose}
      footer={
        <>
          <span className="total">
            {quote.price !== null ? money(quote.price, club.currency) : "—"}
            <small>
              {minutes > 0 ? duration(minutes * MINUTE) : ""}
              {repeat && ` · ${t("booking.perWeek")}`}
            </small>
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="new-booking" disabled={busy || quote.price === null}>
            {busy ? t("common.saving") : repeat ? t("booking.confirmWeekly", { weeks }) : t("booking.confirm")}
          </button>
        </>
      }
    >
      <form id="new-booking" onSubmit={submit} className="form">
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
          {QUICK.map((m) => (
            <button type="button" key={m} className={minutes === m ? "on" : ""} onClick={() => setLength(m)}>
              {m} {t("booking.min")}
            </button>
          ))}
        </div>
        {quote.error && <p className="field-error">{quote.error}</p>}
        <CustomerFields
          name={name}
          phone={phone}
          onChange={(n, p) => {
            setName(n);
            setPhone(p);
          }}
        />

        <label className="switch">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>
            {t("booking.repeatWeekly")}
            <small className="muted">{t("booking.repeatHint")}</small>
          </span>
        </label>
        {repeat && (
          <div className="weekly-box">
            <div className="field-row">
              <label className="field">
                <span>{t("booking.weeks")}</span>
                <input type="number" min={2} max={52} value={weeks} onChange={(e) => setWeeks(Math.min(52, Math.max(2, Number(e.target.value) || 2)))} />
              </label>
              <button type="button" className="btn" onClick={checkWeeks} disabled={busy || quote.price === null}>
                {t("booking.checkWeeks")}
              </button>
            </div>
            {plan && (
              <>
                <p className="small">{t("booking.weeksFree", { free: freeWeeks, total: plan.length })}</p>
                <ul className="week-list">
                  {plan.map((w) => (
                    <li key={w.start_at} className={w.ok ? "ok" : "taken"}>
                      <span>{w.ok ? "✓" : "✕"}</span>
                      {shortDate(dateIn(w.start_at, club.timezone))}
                      {!w.ok && <small>{w.code ? t(`error.${w.code}`) : w.detail}</small>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}

function OpenPlayModal({
  court,
  now,
  onClose,
  onDone,
}: {
  court: Court;
  now: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.startOpenPlay({ court: court.id, customer_name: name.trim(), customer_phone: phone.trim() });
      notify(t("openPlay.started", { court: court.name }));
      onDone();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("openPlay.title")}
      subtitle={t("openPlay.startsNow", { court: court.name, time: clockTime(new Date(now).toISOString(), club.timezone) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn btn-primary" form="open-play" disabled={busy}>
            {busy ? t("common.saving") : `▶ ${t("openPlay.start")}`}
          </button>
        </>
      }
    >
      <form id="open-play" onSubmit={submit} className="form">
        <p className="note">{t("openPlay.explain")}</p>
        <CustomerFields
          name={name}
          phone={phone}
          onChange={(n, p) => {
            setName(n);
            setPhone(p);
          }}
        />
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
