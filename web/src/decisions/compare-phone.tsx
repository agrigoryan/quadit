// The compare view on a phone: one option per screen, swiped through with
// a thumb, and the pick buttons fixed at the bottom where the thumb rests.

import { useEffect, useLayoutEffect, useRef } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { PaneMedia } from "@/decisions/compare-panes";
import { type Compare, paneNote } from "@/decisions/compare-state";
import { Transport } from "@/decisions/compare-transport";
import { useMemberName } from "@/decisions/data";
import { FileStepper } from "@/decisions/file-stepper";
import { PickedBadge, RecommendedBadge } from "@/decisions/option-marks";
import { StageButton } from "@/decisions/stage-ui";

/** What the bottom bar says to someone who cannot pick: who is to answer, or what the answer was. */
function Standing({ c }: { c: Compare }) {
  const { decision, viewer } = c;
  const asked = useMemberName(decision.asked_id, t("common.someone"));
  if (decision.state === "open") {
    if (!viewer.isAsker) return null;
    return (
      <p className="py-2 text-center text-sm text-inverse-ink/70">
        {decision.asked_id ? t("decision.waiting", { name: asked }) : t("decision.waitingAnyone")}
      </p>
    );
  }
  const outcome = decision.outcome ?? (decision.state === "sent_back" ? "none" : "as_is");
  return <p className="py-2 text-center text-sm font-medium text-inverse-ink">{t(`decision.outcome.${outcome}`)}</p>;
}

export function ComparePhone({ c }: { c: Compare }) {
  const { options, focus, focused, viewer, zoom } = c;
  const scroller = useRef<HTMLDivElement | null>(null);
  /** The slide a tap or key is scrolling to; scroll positions on the way there are not swipes. */
  const heading = useRef<{ to: number; timer: number } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = c.start.option * el.clientWidth;
    // Only where the view opens.
  }, []);

  useEffect(() => {
    zoom.fit();
    const el = scroller.current;
    if (!el || Math.round(el.scrollLeft / el.clientWidth) === focus) return;
    if (heading.current) clearTimeout(heading.current.timer);
    heading.current = { to: focus, timer: window.setTimeout(() => (heading.current = null), 700) };
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: focus * el.clientWidth, behavior: calm ? "auto" : "smooth" });
    // Follows the focus only; the zoom starts over on each option.
  }, [focus]);

  function onScroll() {
    const el = scroller.current;
    if (!el || el.clientWidth === 0) return;
    const at = Math.round(el.scrollLeft / el.clientWidth);
    if (heading.current) {
      if (at === heading.current.to) {
        clearTimeout(heading.current.timer);
        heading.current = null;
      }
      return;
    }
    if (at !== focus) c.focusOn(at);
  }

  if (!focused) return null;
  const note = paneNote(c, focused);
  return (
    <>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain no-scrollbar"
      >
        {options.map((option) => (
          <section
            key={option.id}
            aria-label={option.label}
            className="flex w-full shrink-0 snap-center snap-always flex-col"
          >
            <PaneMedia c={c} option={option} gauge={option.id === focused.id} swipeThrough />
          </section>
        ))}
      </div>

      <div className="shrink-0 bg-inverse px-4 pt-2.5">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate text-base font-semibold text-inverse-ink">{focused.label}</h3>
          {c.decision.picked_option_id === focused.id && <PickedBadge />}
          {c.decision.recommended_option_id === focused.id && <RecommendedBadge />}
          <span className="flex-1" />
          <span className="shrink-0 text-xs text-inverse-ink/70 tnum" aria-live="polite">
            {t("compare.position", { n: focus + 1, total: options.length })}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 min-h-9 text-xs text-inverse-ink/70">{note}</p>
        <div className="flex h-8 items-center justify-between gap-2">
          {options.length <= 8 ? (
            <div className="-ml-2 flex">
              {options.map((option, i) => (
                <button
                  key={option.id}
                  type="button"
                  aria-label={option.label}
                  aria-current={i === focus ? "true" : undefined}
                  onClick={() => c.focusOn(i)}
                  className="flex size-8 items-center justify-center focus-visible:outline-white"
                >
                  <span className={cx("size-2 rounded-full", i === focus ? "bg-white" : "bg-white/30")} />
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <FileStepper
            onDark
            index={c.fileIndexOf(focused)}
            total={c.filesOf(focused).length}
            onStep={(delta) => c.stepFile(focused, delta)}
          />
        </div>
      </div>

      {c.hasVideo(options) && <Transport c={c} />}

      <div className="shrink-0 border-t border-white/10 bg-inverse px-3 pt-2.5 pb-safe">
        {viewer.canAnswer ? (
          <div className="flex items-center gap-2">
            <Button
              size="lg"
              variant={viewer.mine ? "move" : "secondary"}
              className="h-12! min-w-0 flex-1"
              onClick={() => c.onPick(focused.id)}
            >
              {t("decision.pick")}
            </Button>
            <StageButton
              className="h-12! px-3! text-sm! text-inverse-ink! ring-1 ring-white/25 ring-inset"
              aria-label={t("decision.pickChanges")}
              onClick={() => c.onPickWithChanges(focused)}
            >
              {t("decision.pickChangesShort")}
            </StageButton>
            <StageButton className="h-12! px-3! text-sm!" aria-label={t("decision.none")} onClick={c.onNone}>
              {t("decision.noneShort")}
            </StageButton>
          </div>
        ) : (
          <Standing c={c} />
        )}
      </div>
    </>
  );
}
