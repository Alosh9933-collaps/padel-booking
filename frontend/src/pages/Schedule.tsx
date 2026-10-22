import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Api, ApiError, messageOf, type Booking, type Court, type Slot } from "../api";
import { Modal } from "../components/Modal";
import { addDays, clockTime, duration, longDate, money, todayIn } from "../format";
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
  offset: string; // UTC offset of the club on this day, e.g. "+03:00"
}

function timelineOf(rows: Slot[]): Timeline | null {
  if (!rows.length) return null;
  const start = Date.parse(rows[0].start);
  return {
    rows,
    start,
    end: Date.parse(rows[rows.length - 1].end),
    slotMs: Date.parse(rows[0].end) - start,
    offset: rows[0].start.match(/([+-]\d\d:\d\d|Z)$/)?.[1] ?? "Z",
  };
}

function y(t: Timeline, ms: number) {
  return ((ms - t.start) / t.slotMs) * ROW_HEIGHT;
}

/** Where a booking ends on the board. Running open play ends "now". */
function shownEnd(b: Booking, now: number) {
  return b.is_open ? Math.min(Math.max(now, Date.parse(b.start_at) + MINUTE), Date.parse(b.end_at)) : Date.parse(b.end_at);
}

export default function Schedule() {
  const { club } = useClub();
  const [date, setDate] = useState(() => todayIn(club.timezone));
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<{ court: Court; start: number } | null>(null);
  const [openPlayCourt, setOpenPlayCourt] = useState<Court | null>(null);
  const [opened, setOpened] = useState<Booking | null>(null);
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
        if (!cancelled) setError(messageOf(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [club.id, date, version]);

  const reload = () => setVersion((v) => v + 1);
  const today = todayIn(club.timezone);
  const timeline = data && data.courts.length ? timelineOf(data.slots[data.courts[0].id] ?? []) : null;
  const dayIsOver = timeline !== null && timeline.end - MINUTE <= now;
  const clubIsOpenNow = timeline !== null && date === today && now >= timeline.start && now < timeline.end - MINUTE;

  const stats = useMemo(() => {
    if (!data || !timeline) return null;
    const courtMs = (timeline.end - timeline.start) * data.courts.length;
    const bookedMs = data.bookings.reduce(
      (sum, b) => sum + Math.max(0, Math.min(shownEnd(b, now), timeline.end) - Math.max(Date.parse(b.start_at), timeline.start)),
      0,
    );
    return {
      count: data.bookings.length,
      live: data.bookings.filter((b) => b.is_open).length,
      revenue: data.bookings.reduce((sum, b) => sum + Number(b.price), 0),
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
          <p className="eyebrow">Schedule</p>
          <h1>{longDate(date)}</h1>
        </div>
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
            ‹
          </button>
          <button className="btn" onClick={() => setDate(today)} disabled={date === today}>
            Today
          </button>
          <input
            type="date"
            className="date-input"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            aria-label="Date"
          />
          <button className="btn" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">
            ›
          </button>
        </div>
      </header>

      {stats && (
        <div className="stat-row">
          <StatTile label="Bookings" value={String(stats.count)}>
            {stats.live > 0 && <span className="stat-sub live-sub">● {stats.live} playing now</span>}
          </StatTile>
          <StatTile label="Booked revenue" value={money(stats.revenue, club.currency)}>
            {stats.live > 0 && <span className="stat-sub">open play is added when stopped</span>}
          </StatTile>
          <StatTile label="Occupancy" value={`${stats.occupancy}%`}>
            <div className="meter" aria-hidden>
              <span style={{ width: `${stats.occupancy}%` }} />
            </div>
          </StatTile>
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {dayIsOver && (
        <div className="banner">
          <span>
            {date === today
              ? "Today's booking hours are over, so no new booking can start."
              : "This day is in the past, so no slot can be booked."}
          </span>
          <button className="btn btn-primary btn-small" onClick={() => setDate(addDays(today, 1))}>
            Go to tomorrow →
          </button>
        </div>
      )}

      {data && data.courts.length === 0 && (
        <div className="card empty">
          <h3>No active courts</h3>
          <p className="muted">Add a court on the Courts page to start taking bookings.</p>
        </div>
      )}

      {data && timeline && (
        <>
          <div className="legend">
            <span><i className="sw sw-free" /> Free (click to book any time)</span>
            <span><i className="sw sw-booked" /> Booked</span>
            <span><i className="sw sw-live" /> Open play (running)</span>
            <span><i className="sw sw-closed" /> Past or no price</span>
          </div>
          <div className={`board-wrap${loading ? " is-loading" : ""}`}>
            <div className="board" style={{ gridTemplateColumns: `64px repeat(${data.courts.length}, minmax(170px, 1fr))` }}>
              <div className="board-corner" />
              {data.courts.map((court) => (
                <div key={court.id} className="board-court">
                  <div>
                    <strong>{court.name}</strong>
                    <span>{court.kind}</span>
                  </div>
                  {clubIsOpenNow && (
                    <button className="open-play-btn" onClick={() => setOpenPlayCourt(court)} title="Start open play now">
                      ▶ Open play
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
                  onOpen={setOpened}
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
          timeline={timeline}
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
      {opened && timeline && (
        <BookingModal
          booking={opened}
          date={date}
          timeline={timeline}
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
  const { club } = useClub();
  return (
    <div className="board-col" style={{ height: timeline.rows.length * ROW_HEIGHT }}>
      {slots.map((slot, i) => {
        const open = slot.price !== null && Date.parse(slot.end) - MINUTE > now;
        const style = { top: i * ROW_HEIGHT, height: ROW_HEIGHT - 2 };
        if (!open) {
          return (
            <div key={slot.start} className="cell cell-closed" style={style} title={slot.price === null ? "No price rule covers this time" : undefined}>
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
            aria-label={`Book ${court.name} from ${clockTime(slot.start, club.timezone)}`}
          >
            <span className="cell-price">{money(slot.price, club.currency)}</span>
            <span className="cell-plus">+ Book</span>
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
        return (
          <div key={b.id}>
            {b.is_open && hold > end && (
              <button
                className="booking-hold"
                style={{ top: top + height, height: y(timeline, hold) - top - height }}
                onClick={() => onOpen(b)}
                title="Held for open play until it is stopped"
              >
                <span>held until stopped</span>
              </button>
            )}
            <button
              className={`booking${b.is_open ? " is-live" : ""}${!b.is_open && end <= now ? " is-past" : ""}`}
              style={{ top, height }}
              onClick={() => onOpen(b)}
            >
              <strong>
                {b.is_open && <span className="live-dot" aria-hidden />}
                {b.customer_name}
              </strong>
              {(tall || b.is_open) && (
                <span>
                  {b.is_open
                    ? `since ${clockTime(b.start_at, club.timezone)} · ${duration(now - Date.parse(b.start_at))}`
                    : `${clockTime(b.start_at, club.timezone)}–${clockTime(b.end_at, club.timezone)}`}
                </span>
              )}
              {tall && !b.is_open && <span className="cell-price">{money(b.price, club.currency)}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
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

function hhmm(ms: number, timeZone: string) {
  return clockTime(new Date(ms).toISOString(), timeZone);
}

/** "HH:MM" on the board's day, in the club's timezone. "00:00" as an end means midnight. */
function toIso(date: string, time: string, offset: string, isEnd: boolean) {
  const day = isEnd && time === "00:00" ? addDays(date, 1) : date;
  return `${day}T${time}:00${offset}`;
}

const QUICK = [60, 90, 120];

function NewBookingModal({
  court,
  date,
  start,
  timeline,
  onClose,
  onDone,
}: {
  court: Court;
  date: string;
  start: number;
  timeline: Timeline;
  onClose: () => void;
  onDone: () => void;
}) {
  const { club } = useClub();
  const notify = useToast();
  const [from, setFrom] = useState(() => hhmm(start, club.timezone));
  const [to, setTo] = useState(() => hhmm(Math.min(start + 60 * MINUTE, timeline.end), club.timezone));
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [quote, setQuote] = useState<{ price: string | null; error: string | null }>({ price: null, error: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startIso = toIso(date, from, timeline.offset, false);
  const endIso = toIso(date, to, timeline.offset, true);
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / MINUTE);

  useEffect(() => {
    if (!from || !to) return;
    if (!(minutes > 0)) {
      setQuote({ price: null, error: "The end must be after the start." });
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.quote(court.id, startIso, endIso)
        .then((q) => !cancelled && setQuote({ price: q.price, error: null }))
        .catch((e) => !cancelled && setQuote({ price: null, error: messageOf(e) }));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [court.id, startIso, endIso, minutes, from, to]);

  const setLength = (length: number) => {
    const end = Math.min(Date.parse(startIso) + length * MINUTE, timeline.end);
    setTo(hhmm(end, club.timezone));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.createBooking({
        court: court.id,
        start_at: startIso,
        end_at: endIso,
        customer_name: name.trim(),
        customer_phone: phone.trim(),
      });
      notify(`Booked ${court.name} for ${name.trim()}, ${from}–${to}`);
      onDone();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError && err.status === 409
          ? "This time overlaps another booking on this court. Pick another time."
          : messageOf(err),
      );
    }
  };

  return (
    <Modal
      title="New booking"
      subtitle={`${court.name} · ${longDate(date)}`}
      onClose={onClose}
      footer={
        <>
          <span className="total">
            {quote.price !== null ? money(quote.price, club.currency) : "—"}
            <small>{minutes > 0 ? duration(minutes * MINUTE) : "total"}</small>
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" form="new-booking" disabled={busy || quote.price === null}>
            {busy ? "Booking…" : "Confirm booking"}
          </button>
        </>
      }
    >
      <form id="new-booking" onSubmit={submit} className="form">
        <div className="field-row">
          <label className="field">
            <span>From</span>
            <input type="time" step={60} value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            <span>Until</span>
            <input type="time" step={60} value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
        </div>
        <div className="quick">
          {QUICK.map((m) => (
            <button
              type="button"
              key={m}
              className={minutes === m ? "on" : ""}
              onClick={() => setLength(m)}
            >
              {m} min
            </button>
          ))}
        </div>
        {quote.error && <p className="field-error">{quote.error}</p>}
        <label className="field">
          <span>Customer name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>Phone (optional)</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} inputMode="tel" />
        </label>
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
      notify(`Open play started on ${court.name}`);
      onDone();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Start open play"
      subtitle={`${court.name} · starts now (${hhmm(now, club.timezone)})`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" form="open-play" disabled={busy}>
            {busy ? "Starting…" : "▶ Start now"}
          </button>
        </>
      }
    >
      <form id="open-play" onSubmit={submit} className="form">
        <p className="note">
          No end time. The court stays reserved until you press <strong>Stop</strong>, or until the club
          closes. The customer pays for the exact minutes played.
        </p>
        <label className="field">
          <span>Customer name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>Phone (optional)</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} inputMode="tel" />
        </label>
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}

function BookingModal({
  booking,
  date,
  timeline,
  now,
  onClose,
  onChanged,
}: {
  booking: Booking;
  date: string;
  timeline: Timeline;
  now: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { club } = useClub();
  const notify = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soFar, setSoFar] = useState<string | null>(null);
  const started = Date.parse(booking.start_at);
  const playedUntil = Math.max(Math.floor(now / MINUTE) * MINUTE, started + MINUTE);

  useEffect(() => {
    if (!booking.is_open) return;
    const end = Math.min(playedUntil, Date.parse(booking.end_at));
    Api.quote(booking.court, booking.start_at, new Date(end).toISOString())
      .then((q) => setSoFar(q.price))
      .catch(() => setSoFar(null));
  }, [booking, playedUntil]);

  const run = async (action: () => Promise<Booking>, done: (b: Booking) => string) => {
    setBusy(true);
    try {
      const result = await action();
      notify(done(result));
      onChanged();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const stop = () =>
    run(
      () => Api.stopOpenPlay(booking.id),
      (b) =>
        `Stopped. ${b.customer_name} played ${duration(Date.parse(b.end_at) - Date.parse(b.start_at))}: ${money(b.price, club.currency)}`,
    );
  const cancel = () => run(() => Api.cancelBooking(booking.id), () => "Booking cancelled. The court is free again.");

  const timeLabel = booking.is_open
    ? `since ${clockTime(booking.start_at, club.timezone)}`
    : `${clockTime(booking.start_at, club.timezone)}–${clockTime(booking.end_at, club.timezone)}`;

  if (editing) {
    return (
      <EditBookingModal
        booking={booking}
        date={date}
        timeline={timeline}
        onClose={() => setEditing(false)}
        onSaved={onChanged}
      />
    );
  }

  return (
    <Modal
      title={booking.customer_name}
      subtitle={`${booking.court_name} · ${timeLabel}`}
      onClose={onClose}
      footer={
        confirming ? (
          <>
            <span className="muted grow">Cancel without charging?</span>
            <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </button>
            <button className="btn btn-danger" onClick={cancel} disabled={busy}>
              {busy ? "Cancelling…" : "Yes, cancel"}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-danger-ghost" onClick={() => setConfirming(true)}>
              Cancel booking
            </button>
            <span className="grow" />
            {booking.is_open ? (
              <button className="btn btn-primary" onClick={stop} disabled={busy}>
                {busy ? "Stopping…" : "■ Stop & charge"}
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => setEditing(true)}>
                  ✎ Change time
                </button>
                <button className="btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </>
            )}
          </>
        )
      }
    >
      {booking.is_open && (
        <div className="live-panel">
          <span className="live-badge">
            <span className="live-dot" aria-hidden /> Playing now
          </span>
          <strong>{duration(now - started)}</strong>
          <span>
            {soFar !== null ? `${money(soFar, club.currency)} so far` : "Calculating…"} · charged by the minute
          </span>
        </div>
      )}
      <dl className="details">
        <dt>Phone</dt>
        <dd>{booking.customer_phone || "—"}</dd>
        {!booking.is_open && (
          <>
            <dt>Price</dt>
            <dd>{money(booking.price, club.currency)}</dd>
          </>
        )}
        <dt>Booked at</dt>
        <dd>
          {new Date(booking.created_at).toLocaleString("en-GB", {
            timeZone: club.timezone,
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </dd>
      </dl>
      {error && <div className="alert">{error}</div>}
    </Modal>
  );
}

const ADJUST = [-30, -15, 15, 30, 60];

function EditBookingModal({
  booking,
  date,
  timeline,
  onClose,
  onSaved,
}: {
  booking: Booking;
  date: string;
  timeline: Timeline;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { club } = useClub();
  const notify = useToast();
  const [from, setFrom] = useState(() => clockTime(booking.start_at, club.timezone));
  const [to, setTo] = useState(() => clockTime(booking.end_at, club.timezone));
  const [name, setName] = useState(booking.customer_name);
  const [phone, setPhone] = useState(booking.customer_phone);
  const [quote, setQuote] = useState<{ price: string | null; error: string | null }>({
    price: booking.price,
    error: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startIso = toIso(date, from, timeline.offset, false);
  const endIso = toIso(date, to, timeline.offset, true);
  const minutes = Math.round((Date.parse(endIso) - Date.parse(startIso)) / MINUTE);
  const oldMinutes = Math.round((Date.parse(booking.end_at) - Date.parse(booking.start_at)) / MINUTE);
  const timeChanged =
    Date.parse(startIso) !== Date.parse(booking.start_at) || Date.parse(endIso) !== Date.parse(booking.end_at);

  useEffect(() => {
    if (!from || !to) return;
    if (!(minutes > 0)) {
      setQuote({ price: null, error: "The end must be after the start." });
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      Api.quote(booking.court, startIso, endIso)
        .then((q) => !cancelled && setQuote({ price: q.price, error: null }))
        .catch((e) => !cancelled && setQuote({ price: null, error: messageOf(e) }));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [booking.court, startIso, endIso, minutes, from, to]);

  const adjustEnd = (delta: number) => {
    const end = Math.min(Math.max(Date.parse(endIso) + delta * MINUTE, Date.parse(startIso) + MINUTE), timeline.end);
    setTo(hhmm(end, club.timezone));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await Api.changeBooking(booking.id, {
        ...(timeChanged ? { start_at: startIso, end_at: endIso } : {}),
        customer_name: name.trim(),
        customer_phone: phone.trim(),
      });
      notify(
        timeChanged
          ? `${updated.customer_name}: now ${from}–${to}, ${money(updated.price, club.currency)}`
          : "Booking saved",
      );
      onSaved();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError && err.status === 409
          ? "The new time overlaps another booking on this court."
          : messageOf(err),
      );
    }
  };

  const diff = minutes - oldMinutes;

  return (
    <Modal
      title="Change booking"
      subtitle={`${booking.court_name} · was ${clockTime(booking.start_at, club.timezone)}–${clockTime(booking.end_at, club.timezone)}, ${money(booking.price, club.currency)}`}
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
            Back
          </button>
          <button className="btn btn-primary" form="edit-booking" disabled={busy || quote.price === null || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="edit-booking" onSubmit={submit} className="form">
        <div className="field-row">
          <label className="field">
            <span>From</span>
            <input type="time" step={60} value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            <span>Until</span>
            <input type="time" step={60} value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
        </div>
        <div className="quick">
          {ADJUST.map((m) => (
            <button type="button" key={m} onClick={() => adjustEnd(m)} title={`${m > 0 ? "Extend" : "Shorten"} by ${Math.abs(m)} minutes`}>
              {m > 0 ? `+${m}` : `−${-m}`} min
            </button>
          ))}
        </div>
        {quote.error && <p className="field-error">{quote.error}</p>}
        <label className="field">
          <span>Customer name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>Phone (optional)</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} inputMode="tel" />
        </label>
        {timeChanged && <p className="hint">The price is recalculated by the minute with today's price rules.</p>}
        {error && <div className="alert">{error}</div>}
      </form>
    </Modal>
  );
}
