import type { Booking, Offer } from "./api";
import type { T } from "./i18n";

/** What a discount is called on the bill, in the UI language. */
export function discountLabel(kind: Booking["discount_kind"] | Offer["kind"], note: string, t: T): string {
  switch (kind) {
    case "first_visit":
      return t("discount.first_visit");
    case "nth_visit":
      return t("discount.nth_visit", { visit: note });
    case "category":
      return t("discount.category", { name: note });
    case "manual":
      return note ? t("discount.manualWith", { note }) : t("discount.manual");
    default:
      return "";
  }
}
