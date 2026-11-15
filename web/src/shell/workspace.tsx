// The route of a workspace: loads it, follows it live, and shows the shell
// once it is here, or why it is not.

import { Lock } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
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
  const { ws: workspaceSlug = "" } = useParams();
  const ready = useStore((s) => s.ready && s.slug === workspaceSlug);
  const lost = useAccess((s) => (s.lost?.slug === workspaceSlug ? s.lost : null));
  const [failed, setFailed] = useState<{ slug: string; failure: Failure } | null>(null);
  // What went wrong with another workspace says nothing about this one.
  const failure = failed?.slug === workspaceSlug ? failed.failure : null;
  const [attempt, setAttempt] = useState(0);
  const userId = useSession((s) => s.user?.id);
  const navigate = useNavigate();
  // An install that requires a second step opens no workspace without one: go and set it up.
  const toSecondStep = useEffectEvent(() => void navigate("/account/security", { replace: true }));
  const toWorkspaces = useEffectEvent(() => void navigate("/", { replace: true }));

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => current && setAttempt((n) => n + 1);
    const fail = (failure: Failure) => setFailed({ slug: workspaceSlug, failure });
    startSync(workspaceSlug).then(
      () => current && setFailed(null),
      (err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.code === "second_step_required") return toSecondStep();
        // A 401 has already sent the person to sign in.
        if (err instanceof ApiError && err.status === 401) return;
        if (err instanceof NetworkError) {
          // Not refused, just not reached: keep asking, and at once when the connection is back.
          fail({ kind: "offline" });
          // A copy from an earlier visit may be on screen meanwhile: say that it is not being kept current.
          useStore.setState({ stream: "down" });
          timer = setTimeout(again, retryIn(attempt));
          window.addEventListener("online", again, { once: true });
          return;
        }
        const refused = err instanceof ApiError && (err.status === 403 || err.status === 404);
        fail({ kind: refused ? "refused" : "error", message: errorMessage(err) });
      },
    );
    return () => {
      current = false;
      clearTimeout(timer);
      window.removeEventListener("online", again);
      stopSync();
    };
  }, [workspaceSlug, attempt]);

  // The server ended this person's time here while the workspace was open
  // (lib/sync.ts emptied the copy). Removed: on to the workspaces they still
  // have. Suspended: it is still theirs in name, so say so here.
  useEffect(() => {
    if (!lost) return;
    let current = true;
    const name = useSession.getState().workspaces.find((w) => w.slug === workspaceSlug)?.name ?? workspaceSlug;
    // Not awaited: an effect cannot wait. A failed reload is caught and the session as it stands is read.
    void loadSession()
      .catch(() => {})
      .then(() => {
        if (!current) return;
        const session = useSession.getState();
        if (session.status !== "in") return; // signed out: the router shows the sign-in page
        if (session.workspaces.some((w) => w.slug === workspaceSlug)) {
          setFailed({ slug: workspaceSlug, failure: { kind: "refused", message: lost.message } });
          return;
        }
        toast.info(t("sync.removed", { name }));
        toWorkspaces();
      });
    return () => {
      current = false;
    };
  }, [lost, workspaceSlug]);

  if (ready) return <Shell />;
  if (failure?.kind === "offline")
    return <Offline slug={workspaceSlug} userId={userId} onRetry={() => setAttempt((n) => n + 1)} />;
  if (failure?.kind === "refused")
    return <NoAccess slug={workspaceSlug} message={failure.message} onRetry={() => setAttempt((n) => n + 1)} />;
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
