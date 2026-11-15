// One decision in the log: the question, the task it is on, the options as
// they were shown (with a small picture when they have one), the answer and
// its note, and who asked and answered. The whole entry opens the task at
// that decision.

import { memo } from "react";
import { Check, Pin, ThumbsUp, Undo2 } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { isMedia } from "@/data/files";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import type { Decision, DecisionOption } from "@/types/core";
import { useMemberName } from "@/decisions/data";
import { rich, Who } from "@/decisions/who";
import type { Attached } from "@/detail/data";
import { ProjectGlyph } from "@/ui/project-glyph";
import { useTaskLink } from "@/nav/task-link";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DecisionMark } from "@/ui/icons";
import { MediaThumb } from "@/ui/media";
import type { Dict } from "@/data/store";
import { type Entry, optionsOf, outcomeOf, pickedOption } from "@/insights/decisions/data";
import { revealDecision } from "@/insights/decisions/reveal";
import type { Preference } from "@/types/plan";
import { Ago } from "@/ui/ago";

const SHOWN_OPTIONS = 4;

function StateBadge({ decision, mine }: { decision: Decision; mine: boolean }) {
  const approval = decision.kind === "approval";
  if (decision.state === "open") {
    return mine ? (
      <Badge tone="move">{t("decision.state.yours")}</Badge>
    ) : (
      <Badge tone="wait">{t("decision.state.open")}</Badge>
    );
  }
  if (decision.state === "picked")
    return <Badge tone="ok">{approval ? t("decision.state.approved") : t("decision.state.picked")}</Badge>;
  return <Badge tone="danger">{approval ? t("decision.state.declined") : t("decision.state.sentBack")}</Badge>;
}

/** The mark at the start of an entry: a question still open, an answer, or one sent back. */
function StateMark({ decision, mine }: { decision: Decision; mine: boolean }) {
  if (decision.state === "open") return <DecisionMark mine={mine} className="size-4" />;
  const sentBack = decision.state === "sent_back";
  return (
    <span
      aria-hidden
      className={cx(
        "flex size-4.5 items-center justify-center rounded-full",
        sentBack ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok",
      )}
    >
      {sentBack ? <Undo2 className="size-3" strokeWidth={2.5} /> : <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

interface OptionProps {
  option: DecisionOption;
  file: Attached["file"] | undefined;
  /** Leave room for a picture even when this option has none, so a row of options lines up. */
  tall: boolean;
  picked: boolean;
  recommended: boolean;
}

function OptionChip({ option, file, tall, picked, recommended }: OptionProps) {
  return (
    <li
      className={cx(
        "flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border pr-2 text-xs",
        tall ? "h-10" : "h-6",
        !file && "pl-2",
        picked ? "border-accent bg-accent-soft" : "border-line",
      )}
    >
      {file && <MediaThumb file={file} className="h-full w-11 shrink-0" />}
      <span title={option.description} className={cx("truncate", picked ? "font-medium text-ink" : "text-ink-2")}>
        {option.label}
      </span>
      {picked && (
        <span className="flex shrink-0 items-center gap-0.5 font-semibold text-accent-text">
          <Check className="size-3" strokeWidth={3} aria-hidden />
          {t("decision.picked")}
        </span>
      )}
      {recommended && (
        <span className="flex shrink-0 items-center gap-0.5 text-ink-3">
          <ThumbsUp className="size-3" aria-hidden />
          {t("decision.recommended")}
        </span>
      )}
    </li>
  );
}

/** The answer in words, with its note; or, for a question opened again, why. */
function Answer({ decision }: { decision: Decision }) {
  const asker = useMemberName(decision.created_by, t("common.someone"));
  if (decision.state === "open") {
    if (!decision.unclear_note) return null;
    return (
      <p className="mt-1.5 rounded-sm bg-wait-soft px-2 py-1 text-sm">
        <span className="font-medium text-wait">{t("declog.sentBackUnclear", { name: asker })}</span>{" "}
        <span className="text-ink">{decision.unclear_note}</span>
      </p>
    );
  }
  const option = pickedOption(decision);
  return (
    <div className="mt-1.5 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{t(`decision.outcome.${outcomeOf(decision)}`)}</span>
        {option && <span className="text-ink-2">{option.label}</span>}
      </p>
      {decision.outcome_note && (
        <p className="mt-1 line-clamp-3 border-l-2 border-line-strong pl-2.5 whitespace-pre-line text-ink-2">
          {decision.outcome_note}
        </p>
      )}
    </div>
  );
}

interface Props {
  entry: Entry;
  meId: string;
  /** Files of every option, by option id. */
  files: Dict<Attached[]>;
  /** The standing preference already made from this decision. */
  preference: Preference | undefined;
  /** Owners and admins may make an answer a standing preference. */
  canMake: boolean;
  onMake: (entry: Entry) => void;
}

export const DecisionEntry = memo(function DecisionEntry({ entry, meId, files, preference, canMake, onMake }: Props) {
  const { decision, task, project } = entry;
  const link = useTaskLink(task);
  const open = decision.state === "open";
  const mine = open && decision.asked_id === meId;
  const options = optionsOf(decision);
  const picture = (o: DecisionOption) => files[o.id]?.find((a) => isMedia(a.file))?.file;
  const tall = options.some((o) => !!picture(o));
  // Show the first few options, but never hide the one picked or the one recommended.
  const marked = (o: DecisionOption) => o.id === decision.picked_option_id || o.id === decision.recommended_option_id;
  const rest = options.filter((o) => !marked(o)).slice(0, Math.max(0, SHOWN_OPTIONS - options.filter(marked).length));
  const shown = options.length <= SHOWN_OPTIONS ? options : options.filter((o) => marked(o) || rest.includes(o));

  return (
    <li className={cx("relative flex gap-2.5 border-b border-line/70 py-2.5 pr-4 pl-4 hover:bg-hover/60")}>
      {mine && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-move" />}
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        <StateMark decision={decision} mine={mine} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <Link
            {...link}
            onClick={() => revealDecision(decision.id)}
            aria-label={t("declog.open", { key: task.key, question: decision.question })}
            className="min-w-0 flex-1 font-medium text-pretty outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
          >
            {decision.question}
          </Link>
          <time className="shrink-0 text-xs text-ink-3 tnum" title={exact(entry.at)}>
            <Ago ms={entry.at} />
          </time>
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          <StateBadge decision={decision} mine={mine} />
          <span className="flex min-w-0 items-center gap-1.5">
            {project && <ProjectGlyph project={project} />}
            <span className="shrink-0 tnum">{task.key}</span>
            <span className="truncate text-ink-2">{task.title}</span>
          </span>
          <span className="shrink-0">{t(`declog.kind.${decision.kind}`)}</span>
        </p>

        {shown.length > 0 && (
          <ul aria-label={t("declog.options")} className="mt-2 flex flex-wrap items-center gap-1.5">
            {shown.map((option) => (
              <OptionChip
                key={option.id}
                option={option}
                file={picture(option)}
                tall={tall}
                picked={option.id === decision.picked_option_id}
                recommended={option.id === decision.recommended_option_id}
              />
            ))}
            {options.length > shown.length && (
              <li className="text-xs text-ink-3">{t("declog.moreOptions", { n: options.length - shown.length })}</li>
            )}
          </ul>
        )}

        <Answer decision={decision} />

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
          <span className="flex flex-wrap items-center gap-x-1.5">
            {rich(t(decision.asked_id ? "declog.asked.line" : "declog.asked.anyone"), {
              asker: <Who userId={decision.created_by} capital />,
              asked: <Who userId={decision.asked_id} />,
            })}
            {!open && (
              <time className="text-ink-3 tnum" title={exact(decision.created_at)}>
                <Ago ms={decision.created_at} />
              </time>
            )}
          </span>
          {!open && decision.decided_by && (
            <span className="flex flex-wrap items-center gap-x-1.5">
              {rich(t("declog.answered.line"), { name: <Who userId={decision.decided_by} capital /> })}
              {decision.decided_at && (
                <time className="text-ink-3 tnum" title={exact(decision.decided_at)}>
                  <Ago ms={decision.decided_at} />
                </time>
              )}
            </span>
          )}
          {preference ? (
            <span
              title={preference.body}
              className="relative z-[1] ml-auto inline-flex h-5 items-center gap-1 rounded-sm border border-line px-1.5 font-medium text-ink-2"
            >
              <Pin className="size-3" aria-hidden />
              {t("prefs.isStanding")}
            </span>
          ) : (
            canMake &&
            !open && (
              <Button
                variant="ghost"
                size="sm"
                className="relative z-[1] -mr-2 ml-auto max-sm:h-9"
                onClick={() => onMake(entry)}
              >
                <Pin className="size-3.5" aria-hidden />
                <span className="max-sm:hidden">{t("prefs.make")}</span>
                <span className="sm:hidden">{t("prefs.makeShort")}</span>
              </Button>
            )
          )}
        </div>
      </div>
    </li>
  );
});
