import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";

import {
  Api,
  SESSION_EXPIRED,
  currentUsername,
  isLoggedIn,
  logout,
  messageOf,
  rememberClubId,
  rememberedClubId,
  type Club,
} from "./api";
import { CourtArt, Logo } from "./components/Brand";
import { ROLE_LABEL } from "./format";
import Courts from "./pages/Courts";
import Login from "./pages/Login";
import Prices from "./pages/Prices";
import Revenue from "./pages/Revenue";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";
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
  { to: "/", label: "Schedule", icon: "▦", managersOnly: false },
  { to: "/courts", label: "Courts", icon: "▭", managersOnly: false },
  { to: "/prices", label: "Prices", icon: "◈", managersOnly: false },
  { to: "/revenue", label: "Revenue", icon: "▮", managersOnly: true },
  { to: "/settings", label: "Club settings", icon: "⚙", managersOnly: false },
];

function Shell({ onLogout }: { onLogout: () => void }) {
  const [clubs, setClubs] = useState<Club[] | null>(null);
  const [clubId, setClubId] = useState<number | null>(rememberedClubId);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    Api.clubs()
      .then(setClubs)
      .catch((e) => setError(messageOf(e)));
  }, []);

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
      <CenteredMessage title="Could not load your clubs" action={<button className="btn" onClick={signOut}>Sign out</button>}>
        {error}
      </CenteredMessage>
    );
  }
  if (!clubs) return <div className="splash"><Logo size={56} /></div>;
  if (!value) {
    return (
      <CenteredMessage title="No club yet" action={<button className="btn" onClick={signOut}>Sign out</button>}>
        Your account is not linked to any club. Ask the club owner to add you as staff
        (Django admin → Memberships).
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
                aria-label="Club"
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
                {item.label}
              </NavLink>
            ))}
          </nav>
          <CourtArt className="sidebar-court" />
          <div className="me">
            <div className="avatar" aria-hidden>
              {currentUsername().slice(0, 1).toUpperCase() || "?"}
            </div>
            <div className="me-text">
              <strong>{currentUsername() || "Signed in"}</strong>
              <span className={`role role-${value.club.role}`}>{ROLE_LABEL[value.club.role]}</span>
            </div>
            <button className="icon-btn on-dark" onClick={signOut} title="Sign out" aria-label="Sign out">
              ⎋
            </button>
          </div>
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Schedule key={value.club.id} />} />
            <Route path="/courts" element={<Courts key={value.club.id} />} />
            <Route path="/prices" element={<Prices key={value.club.id} />} />
            <Route path="/revenue" element={<Revenue key={value.club.id} />} />
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
