import { useState, type FormEvent } from "react";

import { login } from "../api";
import { CourtArt, Logo } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { errorText, useT } from "../i18n";

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      onLoggedIn();
    } catch (err) {
      setError(errorText(err, t));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-hero">
        <Logo size={48} light />
        <div className="hero-copy">
          <h1>
            {t("login.line1")}
            <br />
            {t("login.line2")}
            <br />
            <span className="ball-text">{t("login.line3")}</span>
          </h1>
          <p>{t("login.tagline")}</p>
        </div>
        <div className="hero-court-wrap">
          <CourtArt className="hero-court" />
          <span className="hero-ball" aria-hidden />
        </div>
        <ul className="hero-points">
          <li>{t("login.point1")}</li>
          <li>{t("login.point2")}</li>
          <li>{t("login.point3")}</li>
        </ul>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <LanguageSwitch />
          <h2>{t("login.signIn")}</h2>
          <p className="muted">{t("login.hint")}</p>
          <label className="field">
            <span>{t("login.username")}</span>
            {/* Phone keyboards would otherwise capitalise "demo_owner" or "correct" it. */}
            <input
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              dir="ltr"
            />
          </label>
          <label className="field">
            <span>{t("login.password")}</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" />
          </label>
          {error && <div className="alert">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? t("login.signingIn") : t("login.signIn")}
          </button>
        </form>
      </section>
    </div>
  );
}
