// One decision of a task: the question and its files, who asked whom, the
// options side by side with their pick buttons, and the answer once it is in.
// When the question is asked of the viewer, this is where the highlighter goes.

import { useMemo, useState } from "react";
import { Columns3, X } from "lucide-react";
import { cx } from "@/lib/cx";
import { isMedia } from "@/data/files";
import { t } from "@/lib/i18n";
import type { Decision, DecisionOption } from "@/types/core";
import { DecisionMentions } from "@/detail/mentions";
import { Button, IconButton } from "@/ui/button";
import { Markdown } from "@/ui/markdown";
import { deleteDecision, markUnclear, pick } from "@/decisions/actions";
import { CompareView } from "@/decisions/compare-view";
import { EditDecisionDialog } from "@/decisions/edit-decision-dialog";
import {
  mediaAspect,
  type OptionFiles,
  optionsOf,
  pairUp,
  useMemberName,
  useOptionFiles,
  useQuestionFiles,
  useViewer,
} from "@/decisions/data";
import {
  ApprovalAction,
  ApprovalControls,
  DecisionHeader,
  DecisionResult,
  UnclearNote,
} from "@/decisions/decision-meta";
import { NoteDialog, type NotePrompt } from "@/decisions/note-dialog";
import { OptionCard } from "@/decisions/option-card";
import { QuestionFiles } from "@/decisions/question-files";
import { ThreadBody, ThreadToggle } from "@/decisions/thread";

/** Splits each option's files into what can be looked at (before and after pictures joined into pairs) and everything else. */
function splitFiles(files: OptionFiles): { media: OptionFiles; docs: OptionFiles } {
  const media: OptionFiles = {};
  const docs: OptionFiles = {};
  for (const [id, list] of Object.entries(files)) {
    media[id] = pairUp(list.filter(isMedia));
    docs[id] = list.filter((f) => !isMedia(f));
  }
  return { media, docs };
}

export function DecisionBlock({ decision }: { decision: Decision }) {
  const viewer = useViewer(decision);
  const options = optionsOf(decision);
  const files = useOptionFiles(decision);
  const questionFiles = useQuestionFiles(decision);
  const { media, docs } = useMemo(() => splitFiles(files), [files]);
  const allMedia = options.flatMap((o) => media[o.id] ?? []);
  const aspect = allMedia.length > 0 ? mediaAspect(allMedia) : null;
  const askedName = useMemberName(decision.asked_id, t("common.someone"));
  const answererName = useMemberName(decision.decided_by, t("common.someone"));

  const [prompt, setPrompt] = useState<NotePrompt | null>(null);
  const [compare, setCompare] = useState<{ option: number; file: number } | null>(null);
  /** The option whose comments are open under the cards. */
  const [threadOf, setThreadOf] = useState<string | null>(null);
  const [talk, setTalk] = useState(false);
  const [editing, setEditing] = useState(false);

  const open = decision.state === "open";
  const choice = decision.kind === "choice";
  const thread = options.find((o) => o.id === threadOf);

  function answer(optionId: string) {
    pick(decision, { option: optionId });
    setCompare(null);
  }

  function askChanges(option: DecisionOption) {
    setPrompt({
      title: t("decision.changes.title", { label: option.label }),
      label: t("decision.changes.label"),
      required: t("decision.changes.required"),
      submit: t("decision.changes.submit"),
      tone: viewer.mine ? "move" : "primary",
      onSubmit: (note) => {
        pick(decision, { option: option.id, outcome: "with_changes", note });
        setCompare(null);
      },
    });
  }

  function askNone() {
    setPrompt({
      title: t("decision.none.title"),
      description: t("decision.none.description"),
      label: t("decision.none.label"),
      submit: t("decision.none.submit"),
      onSubmit: (note) => {
        pick(decision, { outcome: "none", note });
        setCompare(null);
      },
    });
  }

  function askUnclear() {
    setPrompt({
      title: t("decision.unclear.title"),
      description: t("decision.unclear.description", { name: answererName }),
      label: t("decision.unclear.label"),
      required: t("decision.unclear.required"),
      submit: t("decision.unclear.submit"),
      onSubmit: (note) => markUnclear(decision, note),
    });
  }

  function askDelete() {
    setPrompt({
      title: t("decision.delete.title"),
      description: t("decision.delete.description"),
      submit: t("decision.delete"),
      tone: "danger",
      onSubmit: () => deleteDecision(decision),
    });
  }

  return (
    <article
      id={`decision-${decision.id}`}
      aria-label={decision.question}
      className="@container relative pl-4 max-sm:pl-3.5"
    >
      <span
        aria-hidden
        className={cx(
          "absolute inset-y-0 left-0 w-1 rounded-full",
          viewer.mine ? "bg-move" : open ? "bg-line-strong" : "bg-line",
        )}
      />
      <DecisionHeader decision={decision} viewer={viewer} onEdit={() => setEditing(true)} onDelete={askDelete} />
      <h3 className="mt-1.5 text-lg leading-snug font-semibold tracking-tight text-balance">{decision.question}</h3>
      {decision.details && <Markdown text={decision.details} className="mt-1.5 text-ink-2" />}
      <QuestionFiles files={questionFiles} />
      {!choice && <ApprovalAction decision={decision} />}
      <UnclearNote decision={decision} viewer={viewer} />
      <DecisionResult decision={decision} viewer={viewer} onUnclear={askUnclear} />

      {open && viewer.isAsker && (
        <p className="mt-2 text-sm text-ink-2">
          {decision.asked_id ? t("decision.waiting", { name: askedName }) : t("decision.waitingAnyone")}
        </p>
      )}
      {viewer.canAnswer && decision.asked_id && !viewer.mine && (
        <p className="mt-2 text-sm text-ink-2">{t("decision.askedOf", { name: askedName })}</p>
      )}

      {choice && options.length > 0 && (
        <div
          className={cx(
            "mt-3 flex gap-3 max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto max-sm:p-px sm:grid",
            options.length === 2 || options.length === 4 ? "grid-cols-2" : "@max-lg:grid-cols-2 @lg:grid-cols-3",
          )}
        >
          {options.map((option) => (
            <OptionCard
              key={option.id}
              decision={decision}
              option={option}
              media={media[option.id] ?? []}
              docs={docs[option.id] ?? []}
              aspect={aspect}
              viewer={viewer}
              onCompare={(file) => setCompare({ option: options.indexOf(option), file })}
              onPick={() => answer(option.id)}
              onPickWithChanges={() => askChanges(option)}
              threadOpen={threadOf === option.id}
              onToggleThread={() => setThreadOf(threadOf === option.id ? null : option.id)}
            />
          ))}
        </div>
      )}

      {thread && (
        <section
          aria-label={t("decision.commentsOn", { label: thread.label })}
          className="mt-2 rounded-lg border border-line p-3"
        >
          <div className="mb-2 flex h-6 items-center justify-between gap-2">
            <h4 className="min-w-0 truncate text-xs font-medium text-ink-2">
              {t("decision.commentsOn", { label: thread.label })}
            </h4>
            <IconButton
              label={t("decision.hideComments")}
              size="sm"
              className="max-sm:size-9!"
              onClick={() => setThreadOf(null)}
            >
              <X className="size-4" />
            </IconButton>
          </div>
          <ThreadBody
            key={thread.id}
            decision={decision}
            optionId={thread.id}
            readOnly={!viewer.canComment}
            autoFocus
            placeholder={t("decision.commentOn", { label: thread.label })}
          />
        </section>
      )}

      {choice ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1.5">
          {viewer.canAnswer && (
            <Button className="mr-1 max-sm:h-10" onClick={askNone}>
              {t("decision.none")}
            </Button>
          )}
          {allMedia.length > 0 && (
            <Button
              variant="ghost"
              className={cx("max-sm:h-10", !viewer.canAnswer && "-ml-2")}
              onClick={() => setCompare({ option: 0, file: 0 })}
            >
              <Columns3 className="size-4" aria-hidden />
              {t("decision.compare")}
            </Button>
          )}
          <span className="flex-1" />
          <ThreadToggle decision={decision} open={talk} onToggle={() => setTalk((v) => !v)} />
        </div>
      ) : (
        <>
          {viewer.canAnswer && <ApprovalControls decision={decision} viewer={viewer} />}
          <div className="mt-1.5 -ml-1.5">
            <ThreadToggle decision={decision} open={talk} onToggle={() => setTalk((v) => !v)} />
          </div>
        </>
      )}
      {talk && (
        <ThreadBody
          decision={decision}
          readOnly={!viewer.canComment}
          autoFocus
          placeholder={t("decision.commentOnQuestion")}
          className="mt-1.5"
        />
      )}
      <DecisionMentions taskId={decision.task_id} decisionId={decision.id} />

      {prompt && <NoteDialog prompt={prompt} onClose={() => setPrompt(null)} />}
      {editing && <EditDecisionDialog decision={decision} onClose={() => setEditing(false)} />}
      {compare && (
        <CompareView
          decision={decision}
          options={options}
          media={media}
          viewer={viewer}
          start={compare}
          onClose={() => setCompare(null)}
          onPick={answer}
          onPickWithChanges={askChanges}
          onNone={askNone}
        />
      )}
    </article>
  );
}
