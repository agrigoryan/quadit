import { CloudOff } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { outbox } from "@/data/outbox";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

interface Props {
  /** The workspace being opened, when the address names one: its waiting changes are counted. */
  slug?: string;
  /** Whose changes to count. Before anyone is known to be signed in: the last person who queued one here. */
  userId?: string;
  onRetry: () => void;
}

/**
 * The server cannot be reached. Says what is kept on the device meanwhile;
 * whoever shows this keeps asking, and the app opens by itself when it can.
 */
export function Offline({ slug, userId, onRetry }: Props) {
  const [kept, setKept] = useState(0);
  useEffect(() => {
    let current = true;
    const user = userId ?? outbox.lastUser();
    if (slug && user) void outbox.count(slug, user).then((n) => current && setKept(n));
    return () => {
      current = false;
    };
  }, [slug, userId]);
  return (
    <EmptyState
      icon={<CloudOff />}
      title={t("sync.offlineTitle")}
      hint={
        <>
          {t("sync.offlineHint")}
          {kept > 0 && (
            <span className="mt-2 block font-medium text-wait">
              {t("conn.unsent", { n: kept })}. {t("conn.unsentHint")}
            </span>
          )}
        </>
      }
      action={<Button onClick={onRetry}>{t("common.tryAgain")}</Button>}
    />
  );
}
