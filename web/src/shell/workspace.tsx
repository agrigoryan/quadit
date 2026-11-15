// The route of a workspace: loads it, follows it live, and shows the shell
// once it is here, or why it is not.

import { Lock } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { loadSession, signOut, useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { startSync, stopSync, useAvailability } from "@/lib/sync";
import { toast } from "@/lib/toast";
import { Offline } from "@/shell/offline";
import { Shell } from "@/shell/shell";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

/** Loads the workspace named in the address, follows it live, and shows the shell once it is here. */
export function WorkspaceRoute() {
  const { ws: workspaceSlug = "" } = useParams();
  const availability = useAvailability(workspaceSlug);
  const userId = useSession((s) => s.user?.id);
  const navigate = useNavigate();
  const toSecondStep = useEffectEvent(() => void navigate("/account/security", { replace: true }));
  const toWorkspaces = useEffectEvent(() => void navigate("/", { replace: true }));
  const openAgain = () => startSync(workspaceSlug);

  useEffect(() => {
    startSync(workspaceSlug);
    return stopSync;
  }, [workspaceSlug]);

  // An install that requires a second step opens no workspace without one: go and set it up.
  const secondStepNeeded = availability.is === "second-step-needed";
  useEffect(() => {
    if (secondStepNeeded) toSecondStep();
  }, [secondStepNeeded]);

  // The server ended this person's time here while the workspace was open.
  // Removed: on to the workspaces they still have. Suspended: it is still
  // theirs in name, so opening it again gets the server's reason on screen.
  const lost = availability.is === "lost";
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
        if (session.workspaces.some((w) => w.slug === workspaceSlug)) return startSync(workspaceSlug);
        toast.info(t("sync.removed", { name }));
        toWorkspaces();
      });
    return () => {
      current = false;
    };
  }, [lost, workspaceSlug]);

  switch (availability.is) {
    case "ready":
      return <Shell />;
    case "offline":
      return <Offline slug={workspaceSlug} userId={userId} onRetry={openAgain} />;
    case "refused":
      return <NoAccess slug={workspaceSlug} message={availability.message} onRetry={openAgain} />;
    case "failed":
      return (
        <EmptyState
          title={t("common.loadFailed")}
          hint={availability.message}
          action={<Button onClick={openAgain}>{t("common.tryAgain")}</Button>}
        />
      );
    default:
      // Loading, or on the way elsewhere: to the second step's setup, or wherever a lost workspace leaves the person.
      return <Loading />;
  }
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
