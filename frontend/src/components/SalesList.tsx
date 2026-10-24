import { useEffect, useState } from "react";

import { Api, type Sale } from "../api";
import { clockTime, isolate, ltr, money } from "../format";
import { errorText, useT } from "../i18n";
import { useClub, useToast } from "../session";
import { Modal } from "./Modal";

/** Counter sales of one day, with a way to void one when the money went back. */
export function SalesList({ date, version, onChanged }: { date: string; version: number; onChanged: () => void }) {
  const t = useT();
  const { club } = useClub();
  const notify = useToast();
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [voiding, setVoiding] = useState<Sale | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Api.sales(club.id, date)
      .then(setSales)
      .catch((e) => setError(errorText(e, t)));
  }, [club.id, date, version, t]);

  const confirmVoid = async () => {
    if (!voiding) return;
    try {
      await Api.voidSale(voiding.id, reason.trim());
      notify(t("sale.voided"));
      setVoiding(null);
      setReason("");
      onChanged();
    } catch (e) {
      setError(errorText(e, t));
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>{t("sale.today")}</h2>
        {sales && sales.length > 0 && (
          <strong>
            {money(
              sales.filter((s) => !s.voided_at).reduce((sum, s) => sum + Number(s.total), 0),
              club.currency,
            )}
          </strong>
        )}
      </div>
      {error && <div className="alert">{error}</div>}
      {sales?.length === 0 && <p className="muted">{t("sale.none")}</p>}
      {sales?.map((s) => (
        <div key={s.id} className={`sale-row${s.voided_at ? " is-void" : ""}`}>
          <span className="sale-time">{ltr(clockTime(s.created_at, club.timezone))}</span>
          <span className="grow">
            {s.items.map((i) => isolate(`${i.quantity} × ${i.name}`)).join(", ")}
            <small>
              {t(`method.${s.method}`)}
              {s.customer_name && ` · ${s.customer_name}`}
              {s.created_by_name && ` · ${s.created_by_name}`}
              {s.voided_at && ` · ${t("sale.voidedBy", { name: s.voided_by_name || "—" })}${s.void_reason ? `: ${s.void_reason}` : ""}`}
            </small>
          </span>
          <strong>{money(s.total, club.currency)}</strong>
          {!s.voided_at && (
            <button className="btn btn-small btn-danger-ghost" onClick={() => setVoiding(s)}>
              {t("sale.void")}
            </button>
          )}
        </div>
      ))}
      {voiding && (
        <Modal
          title={t("sale.voidTitle", { amount: money(voiding.total, club.currency) })}
          subtitle={t("sale.voidHint")}
          onClose={() => setVoiding(null)}
          footer={
            <>
              <button className="btn" onClick={() => setVoiding(null)}>
                {t("common.keep")}
              </button>
              <button className="btn btn-danger" onClick={confirmVoid}>
                {t("sale.void")}
              </button>
            </>
          }
        >
          <label className="field">
            <span>{t("refund.reason")}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={t("common.optional")} />
          </label>
        </Modal>
      )}
    </section>
  );
}
