import { type ReactNode, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { LoginPage } from "@/auth/login";
import { loadSession, useSession } from "@/auth/session";
import { SetupPage } from "@/auth/setup";
import { t } from "@/lib/i18n";
import { WorkspaceRoute } from "@/shell/workspace";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";

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
  if (!first) return <EmptyState title={t("common.notFound")} hint={t("common.notFoundHint")} />;
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
