import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError } from "./api";
import { setFormatLanguage } from "./format";
import ar from "./locales/ar";
import en from "./locales/en";
import ru from "./locales/ru";

export type Lang = "en" | "ar" | "ru";
export type Vars = Record<string, string | number>;
export type T = (key: string, vars?: Vars) => string;

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
  { code: "ru", label: "Русский" },
];

const DICTIONARIES: Record<Lang, Record<string, string>> = { en, ar, ru };
const STORAGE_KEY = "padel.lang";

function initialLanguage(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ar" || saved === "ru") return saved;
  } catch {
    // Storage blocked: fall back to the browser language.
  }
  const browser = navigator.language.slice(0, 2);
  return browser === "ar" || browser === "ru" ? browser : "en";
}

function translate(lang: Lang, key: string, vars?: Vars): string {
  let text = DICTIONARIES[lang][key] ?? en[key as keyof typeof en];
  if (text === undefined) {
    if (import.meta.env.DEV) console.warn(`Missing translation key: ${key}`);
    text = key;
  }
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
}

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (lang: Lang) => void;
  t: T;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLanguage);
  // Formatting must follow the language before anything below renders.
  setFormatLanguage(lang);
  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((next: Lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered; still switches for this visit.
    }
    setLangState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ lang, dir, setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, dir, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n() must be used inside <I18nProvider>.");
  return value;
}

export function useT(): T {
  return useI18n().t;
}

/** A user-facing message for any error, translated when the API sent a known code. */
export function errorText(error: unknown, t: T): string {
  if (error instanceof ApiError) {
    const code = (error.data as { code?: string } | null)?.code;
    if (code && `error.${code}` in en) return t(`error.${code}`);
    if (error.status === 401) return t("error.login_failed");
    if (error.status === 403) return t("error.forbidden");
    if (error.status >= 500) return t("error.server");
    return error.message;
  }
  if (error instanceof TypeError) return t("error.network");
  return error instanceof Error ? error.message : t("error.unknown");
}
