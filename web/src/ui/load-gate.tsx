// What a page shows while a read is on its way, or failed.

import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { Loaded } from "@/lib/use-load";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

/** Shows the spinner, the error with "Try again", or the page once its list is here. */
export function LoadGate<T>({ of, children }: { of: Loaded<T>; children: (data: T) => ReactNode }) {
  if (of.data !== undefined) return <>{children(of.data)}</>;
  if (of.error) return <LoadFailed error={of.error} onRetry={() => void of.reload()} />;
  return <Loading />;
}

/** In place of what could not be read: why, and "Try again". */
export function LoadFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <EmptyState
      title={t("s.loadFailed")}
      hint={error}
      action={<Button onClick={onRetry}>{t("common.tryAgain")}</Button>}
    />
  );
}
