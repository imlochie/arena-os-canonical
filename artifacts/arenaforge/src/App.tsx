import { Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation, useParams } from "react-router-dom";
import Nav from "@/components/Nav";
import DesktopRuntimeStatus from "@/components/DesktopRuntimeStatus";
import { OfflineBanner, SwRegister } from "@/components/OfflineKit";
import { ErrorBoundary } from "@/components/error-boundary";
import { routes } from "./routes";
import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { ListeningHostProvider, ListeningWorkspace, isWorkspaceRoute } from "@/components/waveyard/listening/ListeningHost";
import "./app/globals.css";
import "./app/waveyard/waveyard.css";

function RoutePage({ Component }: { Component: any }) {
  const params = useParams();
  return <Component params={params} />;
}
function Shell() {
  const location = useLocation();
  useEffect(() => {
    const name = location.pathname.split("/").filter(Boolean)[0];
    document.title = name
      ? `${name.replaceAll("-", " ").replace(/\b\w/g, c => c.toUpperCase())} — ArenaForge Personal`
      : "ArenaForge Personal — Your Free Private AI Arena";
    window.scrollTo(0, 0);
  }, [location.pathname]);
  const workspaceRoute = isWorkspaceRoute(location.pathname);
  return <ListeningHostProvider>
    <SwRegister />
    <OfflineBanner />
    <Nav />
    <main className={`mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6 ${workspaceRoute ? "pb-16" : "pb-28"}`}>
      {/* Persistent listening host: same tree position on EVERY route, outside
          the routed subtree and its error/suspense boundaries, so audio survives navigation. */}
      {workspaceRoute && <div className="waveyard-room shell wy-shell-top"><WaveyardNav /></div>}
      <ErrorBoundary resetKey="waveyard-listening-host">
        <ListeningWorkspace />
      </ErrorBoundary>
      <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<p className="py-10 text-center text-slate-400">Loading…</p>}>
          <div className={location.pathname.startsWith("/waveyard") ? "waveyard-room" : undefined}>
            <Routes>
              {routes.map(({ path, Component }) =>
                <Route key={path} path={path} element={<RoutePage Component={Component} />} />)}
              <Route path="*" element={<p className="text-center text-slate-400">Page not found. <a href="/">Return to Arena</a></p>} />
            </Routes>
          </div>
        </Suspense>
      </ErrorBoundary>
    </main>
    <DesktopRuntimeStatus />
    <footer className="border-t border-white/10 py-5">
      <p className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 text-center text-xs text-slate-500 sm:px-6">
        <span>ArenaForge Personal · your votes train <em>your</em> leaderboard</span>
        <span className="text-slate-700">·</span>
        <a href="/privacy" className="font-bold text-emerald-300/80 hover:underline">🛡️ Privacy and data handling</a>
        <span className="text-slate-700">·</span>
        <a href="/principles" className="font-bold text-slate-400 hover:underline">📜 Principles</a>
      </p>
    </footer>
  </ListeningHostProvider>;
}
export default function App() {
  return <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}><Shell /></BrowserRouter>;
}
