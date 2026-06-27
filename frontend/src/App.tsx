import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import DashboardPage from "./pages/DashboardPage";
import BacktestPage from "./pages/BacktestPage";
import AdminPage from "./pages/AdminPage";
import SettingsPage from "./pages/SettingsPage";
import WatchlistPage from "./pages/WatchlistPage";
import ScannerPage from "./pages/ScannerPage";
import SignalHistoryPage from "./pages/SignalHistoryPage";
import AlertsPage from "./pages/AlertsPage";
import PortfolioPage from "./pages/PortfolioPage";
import CalendarPage from "./pages/CalendarPage";
import PaperPage from "./pages/PaperPage";
import PaperAnalyticsPage from "./pages/PaperAnalyticsPage";
import PaperJournalPage from "./pages/PaperJournalPage";
import OptionsPage from "./pages/OptionsPage";
import PatternAnalyticsPage from "./pages/PatternAnalyticsPage";
import PpsSignalsPage from "./pages/PpsSignalsPage";
import CommandPalette from "./components/CommandPalette";
import ShortcutsHelp from "./components/ShortcutsHelp";
import BackendOfflineBanner from "./components/BackendOfflineBanner";
import DisclaimerModal from "./components/DisclaimerModal";
import ErrorBoundary from "./components/ErrorBoundary";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useAuth } from "./store/auth";
import "./store/prefs"; // applies the initial theme class on first load

const UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
  "MARUTI", "KOTAKBANK", "BAJFINANCE", "HCLTECH", "WIPRO", "ASIANPAINT", "NESTLEIND", "TITAN", "ADANIENT", "SUNPHARMA",
];

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuth((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  useGlobalShortcuts({
    onOpenPalette: () => setPaletteOpen(true),
    onOpenHelp: () => setHelpOpen(true),
    onCloseAll: () => { setPaletteOpen(false); setHelpOpen(false); },
    onPickIndex: (i) => {
      if (i < 0 || i >= UNIVERSE.length) return;
      if (loc.pathname !== "/") nav(`/?symbol=${UNIVERSE[i]}`);
      else window.dispatchEvent(new CustomEvent("qti:pick-symbol", { detail: UNIVERSE[i] }));
    },
  });

  useEffect(() => {
    const handleOpen = () => setPaletteOpen(true);
    window.addEventListener("qti:open-palette", handleOpen);
    return () => window.removeEventListener("qti:open-palette", handleOpen);
  }, []);

  function pickSymbol(s: string) {
    if (loc.pathname === "/") {
      window.dispatchEvent(new CustomEvent("qti:pick-symbol", { detail: s }));
    } else {
      nav(`/?symbol=${s}`);
    }
  }

  return (
    <ErrorBoundary>
      <BackendOfflineBanner />
      <DisclaimerModal />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
        <Route path="/backtest" element={<RequireAuth><BacktestPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><AdminPage /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        <Route path="/watchlist" element={<RequireAuth><WatchlistPage /></RequireAuth>} />
        <Route path="/scanner" element={<RequireAuth><ScannerPage /></RequireAuth>} />
        <Route path="/signals" element={<RequireAuth><SignalHistoryPage /></RequireAuth>} />
        <Route path="/alerts" element={<RequireAuth><AlertsPage /></RequireAuth>} />
        <Route path="/portfolio" element={<RequireAuth><PortfolioPage /></RequireAuth>} />
        <Route path="/calendar" element={<RequireAuth><CalendarPage /></RequireAuth>} />
        <Route path="/paper" element={<RequireAuth><PaperPage /></RequireAuth>} />
        <Route path="/paper/analytics" element={<RequireAuth><PaperAnalyticsPage /></RequireAuth>} />
        <Route path="/paper/journal" element={<RequireAuth><PaperJournalPage /></RequireAuth>} />
        <Route path="/options" element={<RequireAuth><OptionsPage /></RequireAuth>} />
        <Route path="/patterns/analytics" element={<RequireAuth><PatternAnalyticsPage /></RequireAuth>} />
        <Route path="/patterns/pps" element={<RequireAuth><PpsSignalsPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        symbols={UNIVERSE}
        onPickSymbol={pickSymbol}
      />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </ErrorBoundary>
  );
}
