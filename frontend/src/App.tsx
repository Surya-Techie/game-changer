import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
import "./store/prefs"; // applies the initial theme class on first load

const UNIVERSE = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "ITC", "LT", "BHARTIARTL",
  "MARUTI", "KOTAKBANK", "BAJFINANCE", "HCLTECH", "WIPRO", "ASIANPAINT", "NESTLEIND", "TITAN", "ADANIENT", "SUNPHARMA",
];

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
        <Route path="/" element={<DashboardPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/scanner" element={<ScannerPage />} />
        <Route path="/signals" element={<SignalHistoryPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/paper" element={<PaperPage />} />
        <Route path="/paper/analytics" element={<PaperAnalyticsPage />} />
        <Route path="/paper/journal" element={<PaperJournalPage />} />
        <Route path="/options" element={<OptionsPage />} />
        <Route path="/patterns/analytics" element={<PatternAnalyticsPage />} />
        <Route path="/patterns/pps" element={<PpsSignalsPage />} />
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
