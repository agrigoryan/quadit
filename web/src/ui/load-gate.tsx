// What a page shows while a list read with useLoad is on its way, or failed.

import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { Loaded } from "@/lib/use-load";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

/** Shows the spinner, the error with "Try again", or the page once its list is here. */
export function LoadGate<T>({ of, children }: { of: Loaded<T>; children: (data: T) => ReactNode }) {
  if (of.data !== undefined) return <>{children(of.data)}</>;
  if (of.error) {
    return (
      <EmptyState
        title={t("s.loadFailed")}
        hint={of.error}
        action={<Button onClick={() => void of.reload()}>{t("common.tryAgain")}</Button>}
      />
    );
  }
  return <Loading />;
}
