import { Toast as RToast } from "radix-ui";
import { CircleAlert, X } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { toast, useToasts } from "@/lib/toast";

/** Draws the toasts. Mounted once, at the root. */
export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <RToast.Provider swipeDirection="right" duration={6000} label={t("common.notifications")}>
      {items.map((item) => (
        <RToast.Root
          key={item.id}
          type={item.kind === "error" ? "foreground" : "background"}
          onOpenChange={(open) => !open && toast.dismiss(item.id)}
          className={cx(
            "flex items-start gap-2.5 rounded-lg bg-inverse py-2.5 pr-2 pl-3 text-sm text-inverse-ink shadow-pop animate-pop",
            "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
          )}
        >
          {item.kind === "error" && <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
          <RToast.Description className="min-w-0 flex-1 break-words">{item.text}</RToast.Description>
          {item.action && (
            <RToast.Action altText={item.action.label} asChild>
              <button
                type="button"
                onClick={item.action.run}
                className="shrink-0 rounded-sm px-1.5 font-semibold underline underline-offset-2 hover:opacity-80"
              >
                {item.action.label}
              </button>
            </RToast.Action>
          )}
          <RToast.Close
            aria-label={t("common.dismiss")}
            className="shrink-0 rounded-sm p-0.5 opacity-70 hover:opacity-100"
          >
            <X className="size-3.5" />
          </RToast.Close>
        </RToast.Root>
      ))}
      <RToast.Viewport className="fixed right-0 bottom-0 z-[90] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
    </RToast.Provider>
  );
}
