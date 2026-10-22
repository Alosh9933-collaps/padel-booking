import { LANGUAGES, useI18n } from "../i18n";

export function LanguageSwitch({ dark = false }: { dark?: boolean }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div className={`lang-switch${dark ? " on-dark" : ""}`} role="group" aria-label={t("common.language")}>
      {LANGUAGES.map((l) => (
        <button key={l.code} className={lang === l.code ? "on" : ""} onClick={() => setLang(l.code)} lang={l.code}>
          {l.label}
        </button>
      ))}
    </div>
  );
}
