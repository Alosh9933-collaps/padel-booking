import { useState } from "react";

import type { BookingBill } from "../api";
import { dateIn, longDate, minus, money, timeRange } from "../format";
import { useT } from "../i18n";
import { discountLabel } from "../labels";
import { useClub } from "../session";
import { Modal } from "./Modal";

/** Strip the invisible direction marks used on screen; chat apps get plain text. */
function plain(text: string) {
  return text.replace(/[\u2066-\u2069]/g, "");
}

/** A short text receipt the customer can get on WhatsApp or Telegram, or on paper. */
export function ReceiptModal({ bill, onClose }: { bill: BookingBill; onClose: () => void }) {
  const t = useT();
  const { club } = useClub();
  const [copied, setCopied] = useState(false);
  const cur = (v: string | number) => money(v, club.currency);

  const lines: [string, string][] = [[t("bill.courtTime"), cur(bill.court_total)]];
  for (const item of bill.items) lines.push([`${item.name} × ${item.quantity}`, cur(item.total)]);
  if (Number(bill.discount) > 0) lines.push([discountLabel(bill.discount_kind, bill.discount_note, t), minus(cur(bill.discount))]);
  // On screen the time keeps its direction marks; the chat text gets them stripped.
  const header = [
    `🎾 ${club.name}`,
    `${bill.court_name} · ${longDate(dateIn(bill.start_at, club.timezone))} · ${timeRange(bill.start_at, bill.end_at, club.timezone)}`,
    bill.customer_name,
  ];
  const footer = [
    `${t("bill.total")}: ${cur(bill.total)}`,
    `${t("bill.paid")}: ${cur(bill.paid_total)}`,
    ...(Number(bill.balance) > 0 ? [`${t("bill.due")}: ${cur(bill.balance)}`] : []),
    ...(bill.customer_balance !== null && Number(bill.customer_balance) > 0
      ? [`${t("wallet.balance")}: ${cur(bill.customer_balance)}`]
      : []),
    "",
    t("receipt.thanks"),
  ];
  const text = plain([...header, "", ...lines.map(([a, b]) => `${a}: ${b}`), "", ...footer].join("\n"));
  const phone = bill.customer_phone.replace(/\D/g, "");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const open = (url: string) => window.open(url, "_blank", "noopener");

  return (
    <Modal
      title={t("receipt.title")}
      subtitle={t("receipt.subtitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => window.print()}>
            🖨 {t("receipt.print")}
          </button>
          <button className="btn" onClick={copy}>
            {copied ? `✓ ${t("receipt.copied")}` : t("receipt.copy")}
          </button>
          <span className="grow" />
          <button
            className="btn btn-whatsapp"
            disabled={!phone}
            title={phone ? undefined : t("receipt.noPhone")}
            onClick={() => open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`)}
          >
            WhatsApp
          </button>
          <button className="btn btn-telegram" onClick={() => open(`https://t.me/share/url?url=%20&text=${encodeURIComponent(text)}`)}>
            Telegram
          </button>
        </>
      }
    >
      <div className="receipt printable">
        {header.map((h, i) => (
          <p key={i} className={i === 0 ? "receipt-club" : "muted"}>
            {h}
          </p>
        ))}
        <div className="receipt-lines">
          {lines.map(([a, b], i) => (
            <div key={i}>
              <span>{a}</span>
              <span>{b}</span>
            </div>
          ))}
        </div>
        <div className="receipt-total">
          <span>{t("bill.total")}</span>
          <strong>{cur(bill.total)}</strong>
        </div>
        {footer.slice(1, -2).map((f) => (
          <p key={f} className="muted">
            {f}
          </p>
        ))}
        <p className="receipt-thanks">{t("receipt.thanks")}</p>
      </div>
    </Modal>
  );
}
