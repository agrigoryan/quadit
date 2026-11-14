import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { NoWorkspacePage } from "@/auth/create-workspace";
import { InvitePage } from "@/auth/invite";
import { LoginPage } from "@/auth/login";
import { RegisterPage } from "@/auth/register";
import { ResetConfirmPage, ResetRequestPage } from "@/auth/reset";
import { loadSession, useSession } from "@/auth/session";
import { SetupPage } from "@/auth/setup";
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
  useEffect(() => {
    void loadSession().catch(() => useSession.setState({ status: "out" }));
  }, []);

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
