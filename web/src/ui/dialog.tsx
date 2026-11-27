import type { ReactNode } from "react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { X } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { IconButton } from "@/ui/button";

type Size = "sm" | "md" | "lg";

const widths: Record<Size, string> = { sm: "sm:max-w-sm", md: "sm:max-w-xl", lg: "sm:max-w-3xl" };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always given, for screen readers; hidden from view with hideTitle. */
  title: string;
  hideTitle?: boolean;
  description?: string;
  size?: Size;
  /** Buttons at the bottom, kept in view while the body scrolls. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** What takes the cursor when it opens; by default its first field. */
  initialFocus?: (root: HTMLElement) => HTMLElement | null | undefined;
  /** What takes the cursor back when it closes, where nothing opened it (no trigger to go back to). */
  finalFocus?: () => HTMLElement | null | undefined;
}

/**
 * A modal dialog. It traps focus, closes on Escape, and on a phone becomes
 * a sheet that rises from the bottom so its buttons sit under the thumb.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle,
  description,
  size = "md",
  footer,
  children,
  className,
  initialFocus,
  finalFocus,
}: Props) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade" />
        <RDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            // Start in the first field, not on the Close button (whose tooltip would pop up). A file
            // input is left out: it is hidden behind its button (a picture to upload).
            const root = e.currentTarget as HTMLElement;
            e.preventDefault();
            const first = "[autofocus], input:not([type=hidden]):not([type=file]), textarea";
            (initialFocus?.(root) ?? root.querySelector<HTMLElement>(first) ?? root).focus();
          }}
          onCloseAutoFocus={(e) => {
            const back = finalFocus?.();
            if (!back) return;
            e.preventDefault();
            back.focus();
          }}
          className={cx(
            "fixed z-50 flex flex-col bg-surface text-ink shadow-pop outline-none",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl animate-sheet",
            "sm:inset-x-auto sm:bottom-auto sm:top-[12vh] sm:left-1/2 sm:max-h-[76vh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:rounded-xl sm:animate-pop",
            widths[size],
            className,
          )}
        >
          {hideTitle ? (
            <VisuallyHidden.Root>
              <RDialog.Title>{title}</RDialog.Title>
            </VisuallyHidden.Root>
          ) : (
            <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-1">
              <div>
                <RDialog.Title className="text-base font-semibold">{title}</RDialog.Title>
                {description && (
                  <RDialog.Description className="mt-0.5 text-sm text-ink-2">{description}</RDialog.Description>
                )}
              </div>
              <RDialog.Close asChild>
                <IconButton label={t("common.close")} className="-mr-1.5">
                  <X className="size-4" />
                </IconButton>
              </RDialog.Close>
            </header>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 pb-safe sm:pb-3">
              {footer}
            </footer>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
