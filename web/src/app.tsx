import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { NoWorkspacePage } from "@/auth/create-workspace";
import { InvitePage } from "@/auth/invite";
import { LoginPage } from "@/auth/login";
import { RegisterPage } from "@/auth/register";
import { ResetConfirmPage, ResetRequestPage } from "@/auth/reset";
import { loadSession, useSession } from "@/auth/session";
import { SetupPage } from "@/auth/setup";
import { NetworkError } from "@/lib/api";
import { Offline } from "@/shell/offline";
import { WorkspaceRoute } from "@/shell/workspace";
import { Loading } from "@/ui/spinner";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";

const AdminRoutes = lazy(() => import("@/admin/routes"));
const AccountSecurityPage = lazy(() => import("@/auth/account-security").then((m) => ({ default: m.AccountSecurityPage })));

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

/** "/" goes to the person's first workspace. */
function Home() {
  const first = useSession((s) => s.workspaces[0]);
  if (!first) return <NoWorkspacePage />;
  return <Navigate to={`/${first.slug}`} replace />;
}

export function App() {
  const status = useSession((s) => s.status);
  /** The server could not be asked who is signed in. That is not "signed out": keep asking. */
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => current && setAttempt((n) => n + 1);
    loadSession().then(
      () => current && setUnreachable(false),
      (err: unknown) => {
        if (!current) return;
        if (!(err instanceof NetworkError)) return useSession.setState({ status: "out" });
        setUnreachable(true);
        timer = setTimeout(again, Math.min(1500 * 2 ** Math.min(attempt, 3), 12_000));
        window.addEventListener("online", again, { once: true });
      },
    );
    return () => {
      current = false;
      clearTimeout(timer);
      window.removeEventListener("online", again);
    };
  }, [attempt]);

  if (unreachable && status === "unknown") {
    // The address names the workspace being opened (/games/…): say what waits to be sent there.
    const slug = window.location.pathname.split("/")[1];
    return (
      <div className="h-dvh">
        <Offline slug={slug} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  }

  return (
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
  );
}
