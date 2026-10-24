import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";

import {
  Api,
  SESSION_EXPIRED,
  currentUsername,
  isLoggedIn,
  logout,
  rememberClubId,
  rememberedClubId,
  type Club,
} from "./api";
import { CourtArt, Logo } from "./components/Brand";
import { LanguageSwitch } from "./components/LanguageSwitch";
import { errorText, useI18n } from "./i18n";
import ActivityLog from "./pages/ActivityLog";
import Courts from "./pages/Courts";
import Customers from "./pages/Customers";
import Daily from "./pages/Daily";
import Login from "./pages/Login";
import Menu from "./pages/Menu";
import Prices from "./pages/Prices";
import Revenue from "./pages/Revenue";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";
import Staff from "./pages/Staff";
import { ClubContext } from "./session";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(isLoggedIn);

  useEffect(() => {
    const expired = () => setLoggedIn(false);
    window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, []);

  if (!loggedIn) {
    return (
      <Routes>
        <Route path="*" element={<Login onLoggedIn={() => setLoggedIn(true)} />} />
      </Routes>
    );
  }
  return <Shell onLogout={() => setLoggedIn(false)} />;
}

const NAV = [
  { to: "/", key: "nav.schedule", icon: "▦", managersOnly: false },
  { to: "/daily", key: "nav.daily", icon: "▤", managersOnly: false },
  { to: "/customers", key: "nav.customers", icon: "☺", managersOnly: false },
  { to: "/menu", key: "nav.menu", icon: "☕", managersOnly: false },
  { to: "/revenue", key: "nav.revenue", icon: "▮", managersOnly: true },
  { to: "/activity", key: "nav.activity", icon: "☰", managersOnly: true },
  { to: "/courts", key: "nav.courts", icon: "▭", managersOnly: false },
  { to: "/prices", key: "nav.prices", icon: "◈", managersOnly: false },
  { to: "/staff", key: "nav.staff", icon: "♙", managersOnly: true },
  { to: "/settings", key: "nav.settings", icon: "⚙", managersOnly: false },
];

function Shell({ onLogout }: { onLogout: () => void }) {
  const { t } = useI18n();
  const [clubs, setClubs] = useState<Club[] | null>(null);
  const [clubId, setClubId] = useState<number | null>(rememberedClubId);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    Api.clubs()
      .then(setClubs)
      .catch((e) => setError(errorText(e, t)));
  }, [t]);

  const selectClub = useCallback((id: number) => {
    rememberClubId(id);
    setClubId(id);
  }, []);

  const replaceClub = useCallback((updated: Club) => {
    setClubs((list) => list?.map((c) => (c.id === updated.id ? updated : c)) ?? null);
  }, []);

  const club = clubs?.find((c) => c.id === clubId) ?? clubs?.[0];
  const value = useMemo(
    () =>
      club && clubs
        ? { club, clubs, canManage: club.role !== "receptionist", selectClub, replaceClub }
        : null,
    [club, clubs, selectClub, replaceClub],
  );

  const signOut = () => {
    logout();
    onLogout();
    navigate("/");
  };

  if (error) {
    return (
      <CenteredMessage title={t("shell.loadFailed")} action={<button className="btn" onClick={signOut}>{t("shell.signOut")}</button>}>
        {error}
      </CenteredMessage>
    );
  }
  if (!clubs) return <div className="splash"><Logo size={56} /></div>;
  if (!value) {
    return (
      <CenteredMessage title={t("shell.noClub")} action={<button className="btn" onClick={signOut}>{t("shell.signOut")}</button>}>
        {t("shell.noClubHint")}
      </CenteredMessage>
    );
  }

  return (
    <ClubContext.Provider value={value}>
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-top">
            <Logo size={38} light />
            {clubs.length > 1 ? (
              <select
                className="club-switch"
                value={value.club.id}
                onChange={(e) => selectClub(Number(e.target.value))}
                aria-label={t("shell.club")}
              >
                {clubs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="club-name">{value.club.name}</div>
            )}
          </div>
          <nav className="nav">
            {NAV.filter((item) => value.canManage || !item.managersOnly).map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === "/"} className="nav-link">
                <span className="nav-icon" aria-hidden>
                  {item.icon}
                </span>
                {t(item.key)}
              </NavLink>
            ))}
          </nav>
          <CourtArt className="sidebar-court" />
          <LanguageSwitch dark />
          <div className="me">
            <div className="avatar" aria-hidden>
              {currentUsername().slice(0, 1).toUpperCase() || "?"}
            </div>
            <div className="me-text">
              <strong>{currentUsername() || t("shell.signedIn")}</strong>
              <span className={`role role-${value.club.role}`}>{t(`role.${value.club.role}`)}</span>
            </div>
            <button className="icon-btn on-dark" onClick={signOut} title={t("shell.signOut")} aria-label={t("shell.signOut")}>
              ⎋
            </button>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Schedule key={value.club.id} />} />
            <Route path="/daily" element={<Daily key={value.club.id} />} />
            <Route path="/customers" element={<Customers key={value.club.id} />} />
            <Route path="/menu" element={<Menu key={value.club.id} />} />
            <Route path="/courts" element={<Courts key={value.club.id} />} />
            <Route path="/prices" element={<Prices key={value.club.id} />} />
            <Route path="/revenue" element={<Revenue key={value.club.id} />} />
            <Route path="/staff" element={<Staff key={value.club.id} />} />
            <Route path="/activity" element={<ActivityLog key={value.club.id} />} />
            <Route path="/settings" element={<Settings key={value.club.id} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </ClubContext.Provider>
  );
}

function CenteredMessage({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="splash">
      <div className="card centered-card">
        <Logo size={44} />
        <h1>{title}</h1>
        <p className="muted">{children}</p>
        {action}
      </div>
    </div>
  );
}
