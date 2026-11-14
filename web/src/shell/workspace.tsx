import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { ApiError, errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { startSync, stopSync } from "@/lib/sync";
import { Shell } from "@/shell/shell";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

/** Loads the workspace named in the address, follows it live, and shows the shell once it is here. */
export function WorkspaceRoute() {
  const { ws = "" } = useParams();
  const ready = useStore((s) => s.ready && s.slug === ws);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError("");
    startSync(ws).catch((err: unknown) => {
      // A 401 has already sent the person to sign in.
      if (!(err instanceof ApiError && err.status === 401)) setError(errorMessage(err));
    });
    return stopSync;
  }, [ws, attempt]);

  if (error) {
    return (
      <EmptyState
        title={t("common.loadFailed")}
        hint={error}
        action={<Button onClick={() => setAttempt((n) => n + 1)}>{t("common.tryAgain")}</Button>}
      />
    );
  }
  if (!ready) return <Loading />;
  return <Shell />;
}
