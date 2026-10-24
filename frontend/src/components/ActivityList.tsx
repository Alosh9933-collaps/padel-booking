import type { Activity } from "../api";
import { clockTime, dateIn, dateTime, isolate, ltr, minus, money, shortDate, timeRange } from "../format";
import { useT, type T } from "../i18n";
import { discountLabel } from "../labels";
import { useClub } from "../session";

const ICONS: Record<string, string> = {
  booking: "📅",
  open_play: "▶",
  item: "☕",
  discount: "%",
  payment: "₊",
  refund: "↩",
  sale: "🛒",
  shift: "🔐",
};

/** Money that left the bill or the drawer is shown with a minus. */
const OUTGOING = new Set(["refund.added", "payment.removed", "discount.applied", "sale.voided"]);

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** One readable line about what the action changed. */
function details(a: Activity, t: T, timeZone: string, currency: string): string {
  const d = a.data;
  const parts: string[] = [];
  const when = (start: unknown, end?: unknown) =>
    end ? timeRange(text(start), text(end), timeZone) : ltr(clockTime(text(start), timeZone));

  switch (a.action) {
    case "booking.changed":
      parts.push(t("act.movedFrom", { from: when(d.old_start, d.old_end), to: when(d.start, d.end) }));
      break;
    case "booking.renamed":
      parts.push(`${text(d.old_customer)} → ${text(d.customer)}`);
      break;
    case "booking.weekly":
      parts.push(t("act.weeks", { booked: text(d.booked), weeks: text(d.weeks) }));
      break;
    case "booking.cancelled_series":
      parts.push(t("act.count", { count: text(d.count) }));
      break;
    case "item.added":
      parts.push(isolate(`${text(d.quantity)} × ${text(d.name)}`));
      break;
    case "item.changed":
      parts.push(`${isolate(text(d.name))}: ${ltr(`${text(d.old_quantity)} → ${text(d.quantity)}`)}`);
      break;
    case "discount.applied": {
      const kind = text(d.kind) as Parameters<typeof discountLabel>[0];
      const size = d.fixed ? money(text(d.fixed), currency) : `${Number(d.percent)}%`;
      parts.push(`${discountLabel(kind, text(d.note), t)} (${size})`);
      break;
    }
    case "discount.removed":
      parts.push(discountLabel(text(d.kind) as Parameters<typeof discountLabel>[0], "", t));
      break;
    case "payment.added":
    case "payment.removed":
      parts.push(t(`method.${text(d.method)}`) + (d.payer ? ` · ${text(d.payer)}` : ""));
      break;
    case "refund.added":
      parts.push(t(`method.${text(d.method)}`) + (d.reason ? ` · ${text(d.reason)}` : ""));
      break;
    case "sale.created":
      parts.push(((d.items as string[] | undefined) ?? []).map((i) => isolate(i.replace(" x ", " × "))).join(", "), t(`method.${text(d.method)}`));
      break;
    case "sale.voided":
      if (d.reason) parts.push(text(d.reason));
      break;
    case "shift.closed": {
      const diff = Number(d.difference);
      parts.push(
        t("act.shiftClosed", {
          expected: money(text(d.expected), currency),
          difference: diff === 0 ? "0" : diff < 0 ? minus(money(-diff, currency)) : ltr(`+${money(diff, currency)}`),
        }),
      );
      break;
    }
  }
  if (d.customer && !a.action.startsWith("booking.renamed")) parts.unshift(text(d.customer));
  if (d.court && d.start && !a.action.startsWith("booking.changed")) {
    parts.splice(1, 0, `${text(d.court)} · ${shortDate(dateIn(text(d.start), timeZone))} ${when(d.start, d.end)}`);
  }
  return parts.filter(Boolean).join(" · ");
}

export function ActivityList({
  items,
  compact = false,
  onOpenBooking,
}: {
  items: Activity[];
  compact?: boolean;
  onOpenBooking?: (id: number) => void;
}) {
  const t = useT();
  const { club } = useClub();
  return (
    <ol className={`activity${compact ? " activity-compact" : ""}`}>
      {items.map((a) => {
        const group = a.action.split(".")[0];
        const outgoing = OUTGOING.has(a.action);
        const clickable = Boolean(onOpenBooking && a.booking);
        const line = (
          <>
            <span className={`act-icon act-${group}`} aria-hidden>
              {ICONS[group] ?? "•"}
            </span>
            <span className="act-body">
              <strong>{t(`act.${a.action}`)}</strong>
              <span>{details(a, t, club.timezone, club.currency)}</span>
              <small>
                {compact ? dateTime(a.created_at, club.timezone) : ltr(clockTime(a.created_at, club.timezone))}
                {" · "}
                {a.user_name || t("act.system")}
              </small>
            </span>
            {a.amount !== null && (
              <strong className={`act-amount${outgoing ? " is-out" : ""}`}>
                {outgoing ? minus(money(a.amount, club.currency)) : money(a.amount, club.currency)}
              </strong>
            )}
          </>
        );
        return (
          <li key={a.id}>
            {clickable ? (
              <button className="act-row" onClick={() => onOpenBooking?.(a.booking as number)}>
                {line}
              </button>
            ) : (
              <div className="act-row">{line}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
