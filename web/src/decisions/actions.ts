// Every write a decision takes: answering, reopening, deleting, commenting
// and asking. Each shows at once and is undone if the server refuses it.

import type { Changes } from "@/types/changes.gen";
import { newId } from "@/lib/ids";
import { type ChangeSpec, mutate, send } from "@/data/mutate";
import { after } from "@/lib/rank";
import type { FileRole } from "@/decisions/data";
import { getRows } from "@/data/selectors";
import { getState } from "@/data/store";
import type { Batch } from "@/data/undo";
import type { Decision, FileRow, Outcome } from "@/types/core";

const meId = () => getState().me?.user_id ?? "";

export interface Answer {
  option?: string;
  /** Left out, an option is picked as is. */
  outcome?: Outcome;
  note?: string;
}

/** The change that answers an open decision, and how the answer shows. The first answer stands; the server refuses a second. */
export function answering(decision: Decision, answer: Answer): Batch {
  const outcome: Outcome = answer.outcome ?? "as_is";
  const note = answer.note?.trim() ?? "";
  const args: Changes["decision.pick"] = { id: decision.id };
  if (answer.option) args.option = answer.option;
  if (answer.outcome) args.outcome = answer.outcome;
  if (note) args.note = note;
  return {
    changes: [{ type: "decision.pick", args }],
    show: (tx) =>
      tx.patch("decisions", decision.id, {
        state: outcome === "none" || outcome === "declined" ? "sent_back" : "picked",
        picked_option_id: answer.option ?? null,
        outcome,
        outcome_note: note || null,
        decided_by: meId(),
        decided_at: Date.now(),
        unclear_note: null,
      }),
  };
}

/** Answers an open decision; a refusal is shown. */
export function pick(decision: Decision, answer: Answer) {
  const batch = answering(decision, answer);
  send(batch.changes, batch.show);
}

/**
 * Says an open or sent-back question is no longer needed, with a note when
 * one is given: it is settled without an answer, and stays in the task's
 * history (deleting it is for a question asked by mistake). Shown at once;
 * a refusal is shown.
 */
export function closeDecision(decision: Decision, note: string) {
  const said = note.trim();
  const args: { id: string; note?: string } = { id: decision.id };
  if (said) args.note = said;
  // decision.close comes with the server's commit that adds it; until types/changes.gen.ts has it, it is named here.
  const change = { type: "decision.close", args } as unknown as ChangeSpec;
  send(change, (tx) =>
    tx.patch("decisions", decision.id, {
      state: "not_needed",
      outcome_note: said || null,
      decided_by: meId(),
      decided_at: Date.now(),
    }),
  );
}

/** The asker says the answer does not settle it: the decision opens again for whoever answered. */
export function markUnclear(decision: Decision, note: string) {
  send({ type: "decision.unclear", args: { id: decision.id, note: note.trim() } }, (tx) =>
    tx.patch("decisions", decision.id, {
      state: "open",
      unclear_note: note.trim(),
      asked_id: decision.decided_by ?? null,
      picked_option_id: null,
      outcome: null,
      decided_by: null,
      decided_at: null,
    }),
  );
}

export interface DecisionEdit {
  question: string;
  details: string;
  /** An option's id, or null for no recommendation. */
  recommended: string | null;
  recommendation: string;
}

/**
 * Changes an open question's wording, details or recommendation; only what
 * differs is sent. Only the asker may. Rejects with the server's reason if
 * it is refused.
 */
export async function updateDecision(decision: Decision, edit: DecisionEdit): Promise<void> {
  const args: Changes["decision.update"] = { id: decision.id };
  const local: Record<string, unknown> = {};
  if (edit.question !== decision.question) args.question = local.question = edit.question;
  if (edit.details !== (decision.details ?? "")) {
    args.details = edit.details;
    local.details = edit.details || null;
  }
  if (edit.recommended !== (decision.recommended_option_id ?? null)) {
    args.recommended = edit.recommended;
    local.recommended_option_id = edit.recommended;
  }
  if (edit.recommendation !== (decision.recommendation ?? "")) {
    args.recommendation = edit.recommendation;
    local.recommendation = edit.recommendation || null;
  }
  if (Object.keys(local).length === 0) return;
  await mutate({ type: "decision.update", args }, (tx) => tx.patch("decisions", decision.id, local), { quiet: true });
}

export function deleteDecision(decision: Decision) {
  send({ type: "decision.delete", args: { id: decision.id } }, (tx) =>
    tx.patch("decisions", decision.id, { deleted_at: Date.now() }),
  );
}

/**
 * Brings a deleted question back from the trash. The server refuses while
 * its task is in the trash; the refusal is shown, and the promise rejects.
 */
export function restoreDecision(id: string): Promise<unknown> {
  return mutate({ type: "decision.restore", args: { id } }, (tx) => tx.patch("decisions", id, { deleted_at: null }));
}

/** A comment on one option, or on the decision as a whole. */
export function addComment(decision: Decision, optionId: string | undefined, body: string) {
  const id = newId();
  send(
    { type: "comment.create", args: optionId ? { id, option: optionId, body } : { id, decision: decision.id, body } },
    (tx) =>
      tx.insert("comments", {
        id,
        task_id: decision.task_id,
        subject_type: optionId ? "decision_option" : "decision",
        subject_id: optionId ?? decision.id,
        kind: "comment",
        author_id: meId(),
        body,
        created_at: Date.now(),
      }),
  );
}

/** A file for an option, with its part in a before/after pair when it has one. */
export interface NewOptionFile {
  file: FileRow;
  role?: FileRole;
}

interface NewOption {
  id: string;
  label: string;
  description: string;
  files: NewOptionFile[];
}

export interface NewDecision {
  taskId: string;
  kind: "choice" | "approval";
  question: string;
  details: string;
  options: NewOption[];
  recommended?: string;
  recommendation: string;
  ask?: string;
}

/** Ranks for rows added one after another, as the server will number them. */
function ranks(count: number, start = ""): string[] {
  const out: string[] = [];
  let last = start;
  for (let i = 0; i < count; i++) out.push((last = after(last)));
  return out;
}

/** Opens a decision on a task. Rejects with the server's reason if it is refused. */
export async function openDecision(draft: NewDecision): Promise<void> {
  const id = newId();
  const now = Date.now();
  const choice = draft.kind === "choice";
  const options = choice ? draft.options : [];
  const recommended = choice ? draft.recommended : undefined;
  const optionRanks = ranks(options.length);
  const attachments = options.flatMap((o) => {
    const fileRanks = ranks(o.files.length);
    return o.files.map(({ file, role }, i) => ({
      id: newId(),
      option: o.id,
      file,
      role,
      rank: fileRanks[i] as string,
    }));
  });
  const siblings = getRows("decisions").filter((d) => d.task_id === draft.taskId);
  const lastRank = siblings.reduce((max, d) => (d.rank > max ? d.rank : max), "");

  const args: Changes["decision.open"] = {
    id,
    task: draft.taskId,
    kind: draft.kind,
    question: draft.question.trim(),
    details: draft.details.trim(),
    options: options.map((o) => ({
      id: o.id,
      label: o.label.trim(),
      description: o.description.trim(),
      attachments: attachments
        .filter((a) => a.option === o.id)
        .map((a) => ({ id: a.id, file: a.file.id, ...(a.role ? { role: a.role } : {}) })),
    })),
  };
  if (recommended) {
    args.recommended = recommended;
    args.recommendation = draft.recommendation.trim();
  }
  if (draft.ask) args.ask = draft.ask;

  await mutate(
    { type: "decision.open", args },
    (tx) => {
      tx.insert("decisions", {
        id,
        task_id: draft.taskId,
        kind: draft.kind,
        question: draft.question.trim(),
        details: draft.details.trim() || undefined,
        state: "open",
        asked_id: draft.ask,
        recommended_option_id: recommended,
        recommendation: recommended ? draft.recommendation.trim() || undefined : undefined,
        rank: after(lastRank),
        created_by: meId(),
        created_at: now,
        options: options.map((o, i) => ({
          id: o.id,
          decision_id: id,
          label: o.label.trim(),
          description: o.description.trim() || undefined,
          rank: optionRanks[i],
        })),
      });
      for (const a of attachments) {
        tx.insert("attachments", {
          id: a.id,
          file_id: a.file.id,
          subject_type: "decision_option",
          subject_id: a.option,
          task_id: draft.taskId,
          role: a.role,
          rank: a.rank,
          created_by: meId(),
          created_at: now,
          file: a.file,
        });
      }
    },
    { quiet: true },
  );
}

/** Adds one uploaded file to an option of an open question, as "before", "after" or neither. */
export function attachToOption(decision: Decision, optionId: string, file: FileRow, role?: FileRole) {
  const id = newId();
  let last = "";
  for (const a of getRows("attachments")) {
    if (a.subject_id === optionId && a.rank > last) last = a.rank;
  }
  const args: Changes["attachment.add"] = { id, file: file.id, option: optionId };
  if (role) args.role = role;
  send({ type: "attachment.add", args }, (tx) =>
    tx.insert("attachments", {
      id,
      file_id: file.id,
      subject_type: "decision_option",
      subject_id: optionId,
      task_id: decision.task_id,
      role,
      rank: after(last),
      created_by: meId(),
      created_at: Date.now(),
      file,
    }),
  );
}
