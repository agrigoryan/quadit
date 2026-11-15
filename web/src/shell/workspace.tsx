import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { loadSession, signOut, useSession } from "@/auth/session";
import { ApiError, errorMessage, NetworkError } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { startSync, stopSync, useAccess } from "@/lib/sync";
import { toast } from "@/lib/toast";
import { Offline } from "@/shell/offline";
import { Shell } from "@/shell/shell";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

/** Why the workspace is not on screen. */
type Failure =
  /** The server cannot be reached; asked again by itself. */
  | { kind: "offline" }
  /** The person may not open it (removed, suspended, or it is not theirs). */
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string };

const retryIn = (attempt: number) => Math.min(1500 * 2 ** Math.min(attempt, 3), 12_000);

/** Loads the workspace named in the address, follows it live, and shows the shell once it is here. */
export function WorkspaceRoute() {
  const { ws = "" } = useParams();
  const ready = useStore((s) => s.ready && s.slug === ws);
  const lost = useAccess((s) => (s.lost?.slug === ws ? s.lost : null));
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const userId = useSession((s) => s.user?.id);
  const navigate = useNavigate();

  // Another workspace: what went wrong with the last one says nothing about this one.
  useEffect(() => setFailure(null), [ws]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => current && setAttempt((n) => n + 1);
    startSync(ws).then(
      () => current && setFailure(null),
      (err: unknown) => {
        if (!current) return;
        // An install that requires a second step opens no workspace without one: go and set it up.
        if (err instanceof ApiError && err.code === "second_step_required")
          return navigate("/account/security", { replace: true });
        // A 401 has already sent the person to sign in.
        if (err instanceof ApiError && err.status === 401) return;
        if (err instanceof NetworkError) {
          // Not refused, just not reached: keep asking, and at once when the connection is back.
          setFailure({ kind: "offline" });
          // A copy from an earlier visit may be on screen meanwhile: say that it is not being kept current.
          useStore.setState({ stream: "down" });
          timer = setTimeout(again, retryIn(attempt));
          window.addEventListener("online", again, { once: true });
          return;
        }
        const refused = err instanceof ApiError && (err.status === 403 || err.status === 404);
        setFailure({ kind: refused ? "refused" : "error", message: errorMessage(err) });
      },
    );
    return () => {
      current = false;
      clearTimeout(timer);
      window.removeEventListener("online", again);
      stopSync();
    };
  }, [ws, attempt]);

  // The server ended this person's time here while the workspace was open
  // (lib/sync.ts emptied the copy). Removed: on to the workspaces they still
  // have. Suspended: it is still theirs in name, so say so here.
  useEffect(() => {
    if (!lost) return;
    let current = true;
    const name = useSession.getState().workspaces.find((w) => w.slug === ws)?.name ?? ws;
    loadSession()
      .catch(() => {})
      .then(() => {
        if (!current) return;
        const session = useSession.getState();
        if (session.status !== "in") return; // signed out: the router shows the sign-in page
        if (session.workspaces.some((w) => w.slug === ws)) {
          setFailure({ kind: "refused", message: lost.message });
          return;
        }
        toast.info(t("sync.removed", { name }));
        navigate("/", { replace: true });
      });
    return () => {
      current = false;
    };
  }, [lost]);

  if (ready) return <Shell />;
  if (failure?.kind === "offline")
    return <Offline slug={ws} userId={userId} onRetry={() => setAttempt((n) => n + 1)} />;
  if (failure?.kind === "refused")
    return <NoAccess slug={ws} message={failure.message} onRetry={() => setAttempt((n) => n + 1)} />;
  if (failure) {
    return (
      <EmptyState
        title={t("common.loadFailed")}
        hint={failure.message}
        action={<Button onClick={() => setAttempt((n) => n + 1)}>{t("common.tryAgain")}</Button>}
      />
    );
  }
  return <Loading />;
}

/** The person may not open this workspace. Offers the ones they can. */
function NoAccess({ slug, message, onRetry }: { slug: string; message: string; onRetry: () => void }) {
  const others = useSession((s) => s.workspaces).filter((w) => w.slug !== slug);
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<Lock />}
      title={t("sync.noAccessTitle")}
      hint={
        <>
          {message && (
            <span className="mb-1 block font-medium text-ink">
              {message.charAt(0).toUpperCase() + message.slice(1)}.
            </span>
          )}
          {t("sync.noAccessHint")}
        </>
      }
      action={
        <div className="flex flex-col items-center gap-3">
          {others.length > 0 && (
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-xs text-ink-3">{t("sync.otherWorkspaces")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {others.map((w) => (
                  <Button key={w.id} variant="primary" onClick={() => navigate(`/${w.slug}`)}>
                    {w.icon ? `${w.icon} ${w.name}` : w.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={onRetry}>{t("common.tryAgain")}</Button>
            <Button variant="ghost" onClick={() => void signOut()}>
              {t("top.signOut")}
            </Button>
          </div>
        </div>
      }
    />
  );
}
