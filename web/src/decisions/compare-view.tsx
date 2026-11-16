// The compare view: a decision's options over the whole screen on a dark
// stage, side by side on a desktop (zoom, pan and video playback shared by
// every pane) and as a swipe-through on a phone. Arrow keys move the focus;
// a number key picks, after Enter confirms it.

import { type KeyboardEvent, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog as RDialog } from "radix-ui";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { CompareStage } from "@/decisions/compare-panes";
import { ComparePhone } from "@/decisions/compare-phone";
import { type Compare, type CompareProps, useCompare } from "@/decisions/compare-state";
import { Transport } from "@/decisions/compare-transport";
import { useReturnFocus } from "@/decisions/data";
import { usePhone } from "@/hooks/breakpoints";
import { useMedia } from "@/hooks/use-media";
import { PixelToggle, StageButton, ZoomControls } from "@/decisions/stage-ui";

/** "Pick B: burst?" — what a number key asks before it answers the question. */
function ConfirmBar({ c, onConfirm }: { c: Compare; onConfirm: () => void }) {
  if (!c.pending) return null;
  return (
    <div
      role="alertdialog"
      aria-label={t("compare.confirm", { label: c.pending.label })}
      className="absolute inset-x-0 bottom-24 z-10 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl bg-inverse py-2 pr-2 pl-4 shadow-pop ring-1 ring-white/20 animate-pop"
    >
      <p className="mr-2 min-w-0 truncate text-sm font-semibold text-inverse-ink">
        {t("compare.confirm", { label: c.pending.label })}
      </p>
      <Button autoFocus variant={c.viewer.mine ? "move" : "secondary"} onClick={onConfirm}>
        {t("compare.confirmPick")}
        <Kbd>↵</Kbd>
      </Button>
      <StageButton onClick={() => c.setPending(null)}>
        {t("common.cancel")}
        <Kbd onDark>Esc</Kbd>
      </StageButton>
    </div>
  );
}

export function CompareView(props: CompareProps) {
  const c = useCompare(props);
  const phone = usePhone();
  const wide = useMedia("(min-width: 1100px)");
  const mid = useMedia("(min-width: 820px)");
  const content = useRef<HTMLDivElement | null>(null);
  useReturnFocus();
  const { options, viewer, zoom } = c;

  // Two to four panes at a time; more options than that are paged through.
  const perPage = wide ? 4 : mid ? 3 : 2;
  const first = Math.floor(c.focus / perPage) * perPage;
  const visible = phone ? options : options.slice(first, first + perPage);
  const paged = !phone && options.length > perPage;
  const transport = !phone && c.hasVideo(visible);

  const confirm = () => c.pending && c.onPick(c.pending.id);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" && c.pending) {
      e.preventDefault();
      confirm();
      return;
    }
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
    const chosen = options[digit - 1];
    if (digit && chosen) {
      e.preventDefault();
      c.focusOn(digit - 1);
      if (viewer.canAnswer) c.setPending(chosen.id);
      return;
    }
    // The scrubber keeps its own arrow keys.
    if (e.target instanceof HTMLInputElement) return;
    const onButton = e.target instanceof HTMLButtonElement;
    const keys: Record<string, (() => void) | undefined> = {
      ArrowLeft: () => c.focusOn(c.focus - 1),
      ArrowRight: () => c.focusOn(c.focus + 1),
      ArrowUp: () => c.focused && c.stepFile(c.focused, -1),
      ArrowDown: () => c.focused && c.stepFile(c.focused, 1),
      "+": () => zoom.zoomBy(1.25),
      "=": () => zoom.zoomBy(1.25),
      "-": () => zoom.zoomBy(1 / 1.25),
      "0": zoom.fit,
      p: () => c.setPixelated(!c.pixelated),
      " ": onButton || !c.hasVideo(visible) ? undefined : () => c.setPlaying(!c.playing),
    };
    const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!run) return;
    e.preventDefault();
    run();
  }

  return (
    <RDialog.Root open onOpenChange={(open) => !open && c.onClose()}>
      <RDialog.Portal>
        <RDialog.Content
          ref={content}
          tabIndex={-1}
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            // Start on the stage itself, so a stray Enter or Space presses nothing.
            e.preventDefault();
            content.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (!c.pending) return;
            e.preventDefault();
            c.setPending(null);
            content.current?.focus();
          }}
          className="fixed inset-0 z-50 flex flex-col bg-black text-inverse-ink outline-none animate-fade"
        >
          <header className="flex h-12 shrink-0 items-center gap-1 bg-inverse pr-2 pl-4 max-sm:h-14 max-sm:pr-1">
            <RDialog.Title className="mr-2 min-w-0 flex-1 truncate text-sm font-semibold max-sm:line-clamp-2 max-sm:whitespace-normal">
              {c.decision.question}
            </RDialog.Title>
            {paged && (
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a set of buttons, not form fields: <fieldset> is for those
              <div role="group" aria-label={t("compare.pages")} className="flex items-center">
                <StageButton
                  aria-label={t("compare.prevPage")}
                  tip={t("compare.prevPage")}
                  disabled={first === 0}
                  onClick={() => c.focusOn(first - perPage)}
                >
                  <ChevronLeft className="size-4" aria-hidden />
                </StageButton>
                <span className="px-1 text-xs text-inverse-ink tnum">
                  {t("compare.page", { from: first + 1, to: first + visible.length, total: options.length })}
                </span>
                <StageButton
                  aria-label={t("compare.nextPage")}
                  tip={t("compare.nextPage")}
                  disabled={first + perPage >= options.length}
                  onClick={() => c.focusOn(first + perPage)}
                >
                  <ChevronRight className="size-4" aria-hidden />
                </StageButton>
              </div>
            )}
            {!phone && <ZoomControls c={c} />}
            <PixelToggle c={c} compact={phone} />
            <RDialog.Close asChild>
              <StageButton
                aria-label={t("common.close")}
                tip={t("common.close")}
                hint="Esc"
                className="max-sm:size-10!"
              >
                <X className="size-4" aria-hidden />
              </StageButton>
            </RDialog.Close>
          </header>

          <div className="relative flex min-h-0 flex-1 flex-col">
            {phone ? <ComparePhone c={c} /> : <CompareStage c={c} visible={visible} first={first} />}
            {transport && <Transport c={c} />}
            <ConfirmBar c={c} onConfirm={confirm} />
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
