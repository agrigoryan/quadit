import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";
import { NoWorkspacePage } from "@/auth/create-workspace";
import { DesktopConnectPage } from "@/auth/desktop-connect";
import { InvitePage } from "@/auth/invite";
import { LoginPage } from "@/auth/login";
import { RegisterPage } from "@/auth/register";
import { ResetConfirmPage, ResetRequestPage } from "@/auth/reset";
import { loadSession, useSession } from "@/auth/session";
import { SetupPage } from "@/auth/setup";
import { NetworkError, whenReachable } from "@/data/api";
import { queryClient } from "@/data/query";
import { Offline } from "@/shell/offline";
import { WorkspaceRoute } from "@/shell/workspace";
import { Loading } from "@/ui/spinner";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";

const AdminRoutes = lazy(() => import("@/admin/routes"));
// The cache's inspector, in development only: a production build leaves it out.
const QueryDevtools = import.meta.env.DEV
  ? lazy(() => import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })))
  : () => null;
const AccountSecurityPage = lazy(() =>
  import("@/settings/me/account-security").then((m) => ({ default: m.AccountSecurityPage })),
);

/** Shows its children only to someone signed in; everyone else goes to /login. */
function RequireSession({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  const location = useLocation();
  if (status === "unknown") return <Loading />;
  if (status === "out") {
    const next = location.pathname + location.search;
    return <Navigate to={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}

/** The pages of a workspace "/?open=" may name: those the installed app's shortcuts open (public/manifest.webmanifest). */
const SHORTCUT_PAGES = ["my-work", "inbox"];

/** "/" goes to the person's first workspace, or to one of its pages named by ?open=. */
function Home() {
  const first = useSession((s) => s.workspaces[0]);
  const [params] = useSearchParams();
  if (!first) return <NoWorkspacePage />;
  const open = params.get("open") ?? "";
  return <Navigate to={`/${first.slug}${SHORTCUT_PAGES.includes(open) ? `/${open}` : ""}`} replace />;
}

export function App() {
  const status = useSession((s) => s.status);
  /** The server could not be asked who is signed in. That is not "signed out": keep asking. */
  const [unreachable, setUnreachable] = useState(false);
  /** Raised by "Try again": the asking starts over, at once. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    const leaving = new AbortController();
    async function askUntilAnswered() {
      for (let attempt = 0; ; attempt++) {
        try {
          await loadSession();
          if (!leaving.signal.aborted) setUnreachable(false);
          return;
        } catch (err) {
          if (leaving.signal.aborted) return;
          if (!(err instanceof NetworkError)) return useSession.setState({ status: "out" });
          setUnreachable(true);
          await whenReachable(attempt, leaving.signal);
        }
      }
    }
    // Rejects only when the wait is given up below, which is how the asking stops.
    askUntilAnswered().catch(() => {});
    return () => leaving.abort();
  }, [round]);

  if (unreachable && status === "unknown") {
    // The address names the workspace being opened (/games/…): say what waits to be sent there.
    const slug = window.location.pathname.split("/")[1];
    return (
      <div className="h-dvh">
        <Offline slug={slug} onRetry={() => setRound((n) => n + 1)} />
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider delayDuration={350} skipDelayDuration={150}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/reset" element={<ResetRequestPage />} />
            <Route path="/reset/:token" element={<ResetConfirmPage />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route
              path="/desktop/connect"
              element={
                <RequireSession>
                  <DesktopConnectPage />
                </RequireSession>
              }
            />
            <Route
              path="/admin/*"
              element={
                <RequireSession>
                  <Suspense fallback={<Loading />}>
                    <AdminRoutes />
                  </Suspense>
                </RequireSession>
              }
            />
            <Route
              path="/account/security"
              element={
                <RequireSession>
                  <Suspense fallback={<Loading />}>
                    <AccountSecurityPage />
                  </Suspense>
                </RequireSession>
              }
            />
            <Route
              path="/"
              element={
                <RequireSession>
                  <Home />
                </RequireSession>
              }
            />
            <Route
              path="/:ws/*"
              element={
                <RequireSession>
                  <WorkspaceRoute />
                </RequireSession>
              }
            />
          </Routes>
          <Toaster />
        </TooltipProvider>
      </BrowserRouter>
      <Suspense fallback={null}>
        <QueryDevtools />
      </Suspense>
    </QueryClientProvider>
  );
}
