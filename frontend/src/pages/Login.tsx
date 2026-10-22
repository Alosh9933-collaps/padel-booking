import { useState, type FormEvent } from "react";

import { login, messageOf } from "../api";
import { CourtArt, Logo } from "../components/Brand";

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
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
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-hero">
        <Logo size={48} light />
        <div className="hero-copy">
          <h1>
            Every court.
            <br />
            Every slot.
            <br />
            <span className="ball-text">One screen.</span>
          </h1>
          <p>
            Bookings, prices and revenue for your padel club. Double bookings are
            impossible: the database itself refuses them.
          </p>
        </div>
        <div className="hero-court-wrap">
          <CourtArt className="hero-court" />
          <span className="hero-ball" aria-hidden />
        </div>
        <ul className="hero-points">
          <li>
            <strong>Open play</strong> billed by the minute
          </li>
          <li>
            <strong>Peak & off-peak</strong> pricing
          </li>
          <li>
            <strong>Roles</strong> for owners, managers & reception
          </li>
        </ul>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="muted">Use your club staff account.</p>
          <label className="field">
            <span>Username</span>
            <input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && <div className="alert">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}
