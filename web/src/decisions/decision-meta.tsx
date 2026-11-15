// The words around a decision's options: its state and who asked whom, the
// answer once there is one, and the controls of a plain approval.

import { useState } from "react";
import { Check, MoreHorizontal, Pencil, Trash2, Undo2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { exact } from "@/lib/time";
import type { Decision, Outcome } from "@/lib/types";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Input } from "@/ui/input";
import { Markdown } from "@/ui/markdown";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { pick } from "@/decisions/actions";
import { optionsOf, useMemberName, type Viewer } from "@/decisions/data";
import { rich, Who } from "@/decisions/who";
import { Ago } from "@/ui/ago";

function StateBadge({ decision, viewer }: { decision: Decision; viewer: Viewer }) {
  const approval = decision.kind === "approval";
  if (decision.state === "open") {
    return viewer.mine ? (
      <Badge tone="move">{t("decision.state.yours")}</Badge>
    ) : (
      <Badge tone="wait">{t("decision.state.open")}</Badge>
    );
  }
  if (decision.state === "picked")
    return <Badge tone="ok">{approval ? t("decision.state.approved") : t("decision.state.picked")}</Badge>;
  return <Badge tone="danger">{approval ? t("decision.state.declined") : t("decision.state.sentBack")}</Badge>;
}

interface HeaderProps {
  decision: Decision;
  viewer: Viewer;
  onEdit: () => void;
  onDelete: () => void;
}

/** State, "who asked whom", when, and the small menu. On a phone the sentence takes its own line. */
export function DecisionHeader({ decision, viewer, onEdit, onDelete }: HeaderProps) {
  return (
    <header className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
      <StateBadge decision={decision} viewer={viewer} />
      <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-xs text-ink-2 max-sm:order-last max-sm:basis-full">
        {rich(t(decision.asked_id ? "decision.asked" : "decision.askedAnyone"), {
          asker: <Who userId={decision.created_by} capital />,
          asked: <Who userId={decision.asked_id} />,
        })}
        <time className="text-ink-3" title={exact(decision.created_at)}>
          <Ago ms={decision.created_at} />
        </time>
      </p>
      {(viewer.canEdit || viewer.canDelete) && (
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t("decision.menu")} size="sm" className="ml-auto max-sm:size-9">
              <MoreHorizontal className="size-4" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            {viewer.canEdit && (
              <MenuItem icon={<Pencil />} onSelect={onEdit}>
                {t("decision.edit")}
              </MenuItem>
            )}
            {viewer.canDelete && (
              <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
                {t("decision.delete")}
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
      )}
    </header>
  );
}

/** A reopened decision says why: the asker found the answer unclear. */
export function UnclearNote({ decision, viewer }: { decision: Decision; viewer: Viewer }) {
  const asker = useMemberName(decision.created_by, t("common.someone"));
  if (decision.state !== "open" || !decision.unclear_note) return null;
  return (
    <div className="mt-3 rounded-md bg-wait-soft px-3 py-2 text-sm">
      <p className="text-xs font-medium text-wait">
        {viewer.isAsker ? t("decision.unclearNoteMine") : t("decision.unclearNote", { name: asker })}
      </p>
      <p className="mt-0.5 whitespace-pre-line text-ink">{decision.unclear_note}</p>
      {decision.outcome_note && (
        <p className="mt-1.5 text-xs text-ink-2">{t("decision.unclearEarlier", { note: decision.outcome_note })}</p>
      )}
    </div>
  );
}

interface ResultProps {
  decision: Decision;
  viewer: Viewer;
  onUnclear: () => void;
}

/** The answer in words: the outcome, the note, who answered and when. */
export function DecisionResult({ decision, viewer, onUnclear }: ResultProps) {
  if (decision.state === "open") return null;
  const sentBack = decision.state === "sent_back";
  const outcome: Outcome = decision.outcome ?? (sentBack ? "none" : "as_is");
  const option = optionsOf(decision).find((o) => o.id === decision.picked_option_id);
  return (
    <div className="mt-3 flex gap-2.5">
      <span
        aria-hidden
        className={cx(
          "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
          sentBack ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok",
        )}
      >
        {sentBack ? <Undo2 className="size-3" strokeWidth={2.5} /> : <Check className="size-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold">{t(`decision.outcome.${outcome}`)}</span>
          {option && <span className="text-ink-2">{option.label}</span>}
        </p>
        {decision.outcome_note && (
          <div className="mt-1.5 border-l-2 border-line-strong pl-2.5">
            <Markdown text={decision.outcome_note} tight />
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-2">
          {rich(t("decision.answeredBy"), { name: <Who userId={decision.decided_by} capital /> })}
          {decision.decided_at && (
            <time className="text-ink-3" title={exact(decision.decided_at)}>
              <Ago ms={decision.decided_at} />
            </time>
          )}
          {viewer.canReopen && (
            <Button variant="ghost" size="sm" className="ml-1 max-sm:h-9" onClick={onUnclear}>
              {t("decision.unclear")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The exact change an approval is for, as the server will run it: its name and arguments. */
function changeText(action: string, args: unknown): string {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return action;
  return `${action} ${JSON.stringify(args)}`;
}

/** What an approval lets the asker do, in plain words, then the exact change, and whether it has been used. */
export function ApprovalAction({ decision }: { decision: Decision }) {
  const asker = useMemberName(decision.created_by, t("common.someone"));
  if (!decision.action) return null;
  // The exact arguments approved, and when the approval was spent on them.
  const { action_args: args, action_used_at: usedAt } = decision as Decision & {
    action_args?: unknown;
    action_used_at?: number;
  };
  const action = tMaybe(`decision.action.${decision.action}`, t("decision.action.other", { type: decision.action }));
  return (
    <div className="mt-2">
      <p className="text-sm text-ink-2">{t("decision.actionLine", { name: asker, action })}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-ink-2">
        <span className="shrink-0 text-ink-3">{t("decision.change")}</span>
        <code className="min-w-0 rounded-sm bg-sunken px-1 py-0.5 font-mono text-2xs [overflow-wrap:anywhere]">
          {changeText(decision.action, args)}
        </code>
        {!!usedAt && (
          <Badge tone="ok" title={exact(usedAt)}>
            {t("decision.changeUsed")}
          </Badge>
        )}
      </p>
    </div>
  );
}

/** Approve or decline, with room for a note. */
export function ApprovalControls({ decision, viewer }: { decision: Decision; viewer: Viewer }) {
  const [note, setNote] = useState("");
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("decision.approvalNote")}
        aria-label={t("decision.approvalNote")}
        className="min-w-0 flex-1 basis-56 max-sm:h-10 max-sm:basis-full max-sm:text-base"
      />
      <Button className="max-sm:h-10 max-sm:flex-1" onClick={() => pick(decision, { outcome: "declined", note })}>
        {t("decision.decline")}
      </Button>
      <Button
        variant={viewer.mine ? "move" : "secondary"}
        className="max-sm:h-10 max-sm:flex-1"
        onClick={() => pick(decision, { outcome: "approved", note })}
      >
        {t("decision.approve")}
      </Button>
    </div>
  );
}
