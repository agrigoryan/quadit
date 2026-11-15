// One option of a choice, as a card: its media, label and description, the
// asker's recommendation, the buttons that pick it, and the count of its
// comments (the thread itself opens under the row of cards, at full width).

import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Decision, DecisionOption } from "@/lib/types";
import { Button } from "@/ui/button";
import type { OptionFile, Viewer } from "@/decisions/data";
import { AttachToOption } from "@/decisions/option-attach";
import { NoMediaCaption, OptionDocs, OptionMedia } from "@/decisions/option-media";
import { PickedBadge, RecommendedBadge } from "@/decisions/option-marks";
import { ThreadToggle } from "@/decisions/thread";

interface Props {
  decision: Decision;
  option: DecisionOption;
  /** Pictures and videos, shown at the top; a before/after pair is one entry. */
  media: OptionFile[];
  /** Any other files, shown as links. */
  docs: OptionFile[];
  /** Whether any option of this decision has media: cards then keep the same shape. */
  aspect: number | null;
  viewer: Viewer;
  onCompare: (fileIndex: number) => void;
  onPick: () => void;
  onPickWithChanges: () => void;
  threadOpen: boolean;
  onToggleThread: () => void;
}

export function OptionCard({
  decision,
  option,
  media,
  docs,
  aspect,
  viewer,
  onCompare,
  onPick,
  onPickWithChanges,
  threadOpen,
  onToggleThread,
}: Props) {
  const answered = decision.state !== "open";
  const picked = decision.picked_option_id === option.id;
  const recommended = decision.recommended_option_id === option.id;

  return (
    <article
      aria-label={option.label}
      className={cx(
        "flex min-w-0 flex-col rounded-lg border bg-surface max-sm:w-[84%] max-sm:shrink-0 max-sm:snap-start",
        picked ? "border-accent ring-1 ring-accent" : "border-line",
        answered && !picked && "opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100",
      )}
    >
      {media.length > 0 ? (
        <OptionMedia files={media} label={option.label} aspect={aspect ?? 4 / 3} onOpen={onCompare} />
      ) : (
        aspect !== null && (
          <>
            <div aria-hidden className="rounded-t-[9px] bg-sunken" style={{ aspectRatio: aspect }} />
            <NoMediaCaption />
          </>
        )
      )}

      <div className="flex flex-1 flex-col p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="min-w-0 text-sm font-semibold break-words">{option.label}</h4>
          {picked && <PickedBadge />}
          {recommended && <RecommendedBadge />}
        </div>
        {option.description && <p className="mt-0.5 text-xs whitespace-pre-line text-ink-2">{option.description}</p>}
        {recommended && decision.recommendation && (
          <p className="mt-2 border-l-2 border-accent pl-2 text-xs text-ink-2">{decision.recommendation}</p>
        )}
        <OptionDocs files={docs} />

        {viewer.canAnswer && (
          <div className="mt-auto flex flex-col gap-1.5 pt-3">
            <Button variant={viewer.mine ? "move" : "secondary"} className="w-full max-sm:h-10" onClick={onPick}>
              {t("decision.pick")}
            </Button>
            <Button variant="ghost" className="w-full max-sm:h-10" onClick={onPickWithChanges}>
              {t("decision.pickChanges")}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-1 border-t border-line px-1.5 py-1">
        <ThreadToggle decision={decision} optionId={option.id} open={threadOpen} onToggle={onToggleThread} />
        {viewer.canEdit && <AttachToOption decision={decision} option={option} />}
      </div>
    </article>
  );
}
