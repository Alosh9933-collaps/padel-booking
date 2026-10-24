// Dates travel as YYYY-MM-DD strings in the club's own timezone; times are
// always shown in that timezone, whatever the browser's timezone is.
// Formatting follows the UI language, set by the I18nProvider.

import type { Lang } from "./i18n";

const INTL_LOCALE: Record<Lang, string> = {
  en: "en-GB",
  ar: "ar-u-nu-latn", // Arabic words, Latin digits: clearer for times and prices
  ru: "ru-RU",
};

const UNITS: Record<Lang, { h: string; m: string; min: string }> = {
  en: { h: "h", m: "m", min: "min" },
  ar: { h: "س", m: "د", min: "دقيقة" },
  ru: { h: "ч", m: "мин", min: "мин" },
};

let lang: Lang = "en";
let locale = INTL_LOCALE.en;

export function setFormatLanguage(next: Lang) {
  lang = next;
  locale = INTL_LOCALE[next];
}

export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

/** The club-local calendar date (YYYY-MM-DD) of an instant. */
export function dateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));
}

/** UTC offset of a timezone on a given day, like "+03:00". */
export function zoneOffset(timeZone: string, day: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((p) => p.type === "timeZoneName")?.value;
  const match = part?.match(/GMT([+-]\d\d:\d\d)/);
  return match ? match[1] : "+00:00";
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Short weekday names, Monday first (index 0 = Monday, as in the API). */
export function weekdayNames(width: "short" | "long" = "short"): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" });
  // 1 January 2024 was a Monday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

export function longDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function dateTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString(locale, { timeZone, dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
}

/** Always "HH:MM", 24-hour, in the club's timezone (also used as <input type="time"> values). */
export function clockTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * Keep left-to-right text (times, phones) intact inside Arabic sentences:
 * Unicode isolates stop "12:00–14:00" from being shown as "14:00–12:00".
 */
export function ltr(text: string): string {
  return `⁦${text}⁩`;
}

/**
 * Let a phrase take the direction of its own first letter, so "2 × Coffee"
 * stays in order inside Arabic text and "2 × قهوة" inside English text.
 */
export function isolate(text: string): string {
  return `⁨${text}⁩`;
}

/** A minus amount ("−₽500", "−10%") that keeps its sign in front in right-to-left text. */
export function minus(text: string): string {
  return ltr(`−${text}`);
}

/** "HH:MM–HH:MM" in the club's timezone, safe in right-to-left text. */
export function timeRange(startIso: string, endIso: string, timeZone: string): string {
  return ltr(`${clockTime(startIso, timeZone)}–${clockTime(endIso, timeZone)}`);
}

export function duration(ms: number): string {
  const u = UNITS[lang];
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} ${u.min}`;
  return m ? `${h} ${u.h} ${m} ${u.m}` : `${h} ${u.h}`;
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

export function money(value: string | number | null, currency: string): string {
  if (value === null) return "—";
  const key = `${locale}|${currency}`;
  let format = moneyFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    });
    moneyFormats.set(key, format);
  }
  return format.format(Number(value));
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
