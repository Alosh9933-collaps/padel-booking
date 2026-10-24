import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { Api, type StaffNotification } from "../api";
import { dateIn, dateTime, longDate, money, timeRange } from "../format";
import { useT } from "../i18n";
import { useClub } from "../session";

/** Fired when customers change bookings online, so an open schedule reloads. */
export const BOOKINGS_CHANGED = "padel:bookings-changed";

const POLL_MS = 15_000;
const ICONS: Record<StaffNotification["kind"], string> = {
  online_booking: "🌐",
  online_cancelled: "✕",
  late_payment: "↩",
};

/** A short two-note chime, made on the spot so there is no sound file to load. */
function chime() {
  try {
    const audio = new AudioContext();
    [880, 1320].forEach((frequency, i) => {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.12, audio.currentTime + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + i * 0.16 + 0.3);
      tone.connect(gain).connect(audio.destination);
      tone.start(audio.currentTime + i * 0.16);
      tone.stop(audio.currentTime + i * 0.16 + 0.3);
    });
  } catch {
    // No sound before the first click on the page, or no audio at all: the pop-up is enough.
  }
}

/** The bell in the sidebar, and pop-ups for what customers do online while the admin site is open. */
export function NotificationCenter() {
  const t = useT();
  const { club } = useClub();
  const navigate = useNavigate();
  const [items, setItems] = useState<StaffNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [popups, setPopups] = useState<StaffNotification[]>([]);
  // The newest notification this tab has seen; anything newer pops up.
  const newest = useRef<number | null>(null);

  const title = useCallback((n: StaffNotification) => t(`notify.${n.kind}`), [t]);
  const body = useCallback(
    (n: StaffNotification) =>
      `${n.data.customer_name} · ${n.data.court} · ${longDate(dateIn(n.data.start_at, club.timezone))} ${timeRange(n.data.start_at, n.data.end_at, club.timezone)}`,
    [club.timezone],
  );

  const load = useCallback(async () => {
    try {
      const data = await Api.notifications(club.id);
      const latest = data.items[0]?.id ?? 0;
      const known = newest.current;
      if (known !== null && latest > known) {
        const fresh = data.items.filter((n) => n.id > known);
        setPopups((list) => [...fresh, ...list].slice(0, 3));
        window.dispatchEvent(new Event(BOOKINGS_CHANGED));
        chime();
        // With the tab in the background, the system notification is what staff will notice.
        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
          for (const n of fresh) new Notification(`${ICONS[n.kind]} ${title(n)}`, { body: body(n), tag: `padel-${n.id}` });
        }
      }
      newest.current = Math.max(latest, known ?? 0);
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      // Offline for a moment: the next round tries again.
    }
  }, [club.id, title, body]);

  useEffect(() => {
    newest.current = null;
    setPopups([]);
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggle = async () => {
    const opening = !open;
    setOpen(opening);
    if (!opening) return;
    // Asked on a click, as browsers require.
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    if (unread > 0) {
      try {
        await Api.notificationsSeen(club.id);
        setUnread(0);
      } catch {
        // Stays unread; nothing else depends on it.
      }
    }
  };

  const show = (n: StaffNotification) => {
    setOpen(false);
    setPopups((list) => list.filter((p) => p.id !== n.id));
    if (n.booking) navigate(`/?date=${dateIn(n.data.start_at, club.timezone)}&booking=${n.booking}`);
  };

  return (
    <>
      <button
        className={`bell${unread ? " has-unread" : ""}`}
        onClick={toggle}
        aria-label={t("notify.title")}
        aria-expanded={open}
        title={t("notify.title")}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {createPortal(
        <>
          {open && (
            <>
              <div className="notify-backdrop" onClick={() => setOpen(false)} />
              <section className="notify-panel" role="dialog" aria-label={t("notify.title")}>
                <header>
                  <h2>{t("notify.title")}</h2>
                  <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t("common.close")}>
                    ✕
                  </button>
                </header>
                {items.length === 0 ? (
                  <p className="muted notify-empty">{t("notify.empty")}</p>
                ) : (
                  <ul>
                    {items.map((n) => (
                      <li key={n.id}>
                        <button className={`notify-item${n.unread ? " is-unread" : ""}`} onClick={() => show(n)}>
                          <span className={`notify-icon kind-${n.kind}`} aria-hidden>
                            {ICONS[n.kind]}
                          </span>
                          <span className="notify-text">
                            <strong>{title(n)}</strong>
                            <span>{body(n)}</span>
                            <small className="muted">
                              {Number(n.data.paid) > 0 && `${t("notify.paid", { amount: money(n.data.paid, club.currency) })} · `}
                              {dateTime(n.created_at, club.timezone)}
                            </small>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
          {popups.length > 0 && (
            <div className="notify-popups" aria-live="polite">
              {popups.map((n) => (
                <div key={n.id} className={`notify-popup kind-${n.kind}`} role="status">
                  <span className="notify-icon" aria-hidden>
                    {ICONS[n.kind]}
                  </span>
                  <div className="notify-text">
                    <strong>{title(n)}</strong>
                    <span>{body(n)}</span>
                    <span>
                      📞 <span dir="ltr">{n.data.customer_phone || "—"}</span> · {money(n.data.price, club.currency)}
                      {Number(n.data.paid) > 0 && ` · ${t("notify.paid", { amount: money(n.data.paid, club.currency) })}`}
                      {n.data.amount && ` · ${t("notify.refunded", { amount: money(n.data.amount, club.currency) })}`}
                    </span>
                    {n.booking && (
                      <button className="btn btn-small btn-primary" onClick={() => show(n)}>
                        {t("notify.open")}
                      </button>
                    )}
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => setPopups((list) => list.filter((p) => p.id !== n.id))}
                    aria-label={t("common.close")}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>,
        document.body,
      )}
    </>
  );
}
