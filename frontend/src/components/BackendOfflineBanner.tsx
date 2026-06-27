// Top-of-page banner that appears whenever any API call to the backend
// fails with a transport-level error (ERR_CONNECTION_REFUSED, offline,
// CORS, DNS failure). Subscribes to the global status broadcast set up
// in lib/api.ts.
//
// Once the backend is reachable again the banner auto-dismisses. The
// banner also polls /health every 4s while visible so it disappears
// quickly after the user starts the backend.

import { useEffect, useState } from "react";
import { API_URL, subscribeBackendStatus } from "../lib/api";

export default function BackendOfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    return subscribeBackendStatus((s) => setOffline(s === "offline"));
  }, []);

  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => {
      fetch(`${API_URL}/health`, { method: "GET" })
        .then((r) => { if (r.ok) setOffline(false); })
        .catch(() => {});
    }, 4_000);
    return () => clearInterval(id);
  }, [offline]);

  if (!offline) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-rose-600/95 text-white text-sm px-4 py-2 flex items-center gap-3 shadow-lg">
      <span className="text-lg">⚠️</span>
      <div className="flex-1">
        <div className="font-semibold">QTI backend is not reachable at {API_URL}</div>
        <div className="text-xs opacity-90">
          Start it with <code className="bg-black/30 px-1 rounded">./dev.sh</code> from the repo root
          (boots backend + ai-service + frontend). Or manually: <code className="bg-black/30 px-1 rounded">cd backend &amp;&amp; npm run dev</code>.
        </div>
      </div>
      <a
        href="https://github.com/anthropics/claude-code/issues"
        target="_blank"
        rel="noreferrer"
        className="text-xs underline opacity-80 hover:opacity-100"
      >
        help
      </a>
    </div>
  );
}
