// What the decision views read from the store: a task's decisions, the
// files on each question and option, the comments of each option, and
// what the signed-in person may do.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isImage } from "@/lib/files";
import { useCollection, useMe } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import type { Comment, Decision, DecisionOption, FileRow, Member, SubjectType } from "@/lib/types";

const byRank = (a: { rank: string }, b: { rank: string }) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);

/** A task's decisions: the open ones first, each group in the order asked. */
export function useTaskDecisions(taskId: string): Decision[] {
  const decisions = useCollection("decisions");
  return useMemo(
    () =>
      Object.values(decisions)
        .filter((d) => d.task_id === taskId && !d.deleted_at)
        .sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open") || byRank(a, b)),
    [decisions, taskId],
  );
}

export const optionsOf = (decision: Decision): DecisionOption[] => decision.options ?? [];

/** What a file shows of a change: how it was, or how it is now. */
export type FileRole = "before" | "after";

/** A file on an option, with what its attachment says: who put it there, and its part in a before/after pair. */
export interface OptionFile extends FileRow {
  attachmentId: string;
  role?: FileRole;
  attachedBy: string;
  attachedAt: number;
  /** On the "after" picture of a pair: the "before" it is shown against. */
  before?: OptionFile;
}

/** Each option's files, in order, by option id. */
export type OptionFiles = Record<string, OptionFile[]>;

export function useOptionFiles(decision: Decision): OptionFiles {
  const attachments = useCollection("attachments");
  const options = decision.options;
  return useMemo(() => {
    const out: OptionFiles = {};
    const ids = new Set((options ?? []).map((o) => o.id));
    const rows = Object.values(attachments)
      .filter((a) => a.subject_type === "decision_option" && ids.has(a.subject_id) && !a.deleted_at && a.file)
      .sort(byRank);
    for (const a of rows) {
      const role = a.role === "before" || a.role === "after" ? a.role : undefined;
      (out[a.subject_id] ??= []).push({
        ...(a.file as FileRow),
        attachmentId: a.id,
        role,
        attachedBy: a.created_by,
        attachedAt: a.created_at,
      });
    }
    return out;
  }, [attachments, options]);
}

/** The files on the question itself, in order. */
export function useQuestionFiles(decision: Decision): OptionFile[] {
  const attachments = useCollection("attachments");
  const id = decision.id;
  return useMemo(
    () =>
      Object.values(attachments)
        .filter((a) => a.subject_type === "decision" && a.subject_id === id && !a.deleted_at && a.file)
        .sort(byRank)
        .map((a) => ({
          ...(a.file as FileRow),
          attachmentId: a.id,
          attachedBy: a.created_by,
          attachedAt: a.created_at,
        })),
    [attachments, id],
  );
}

/**
 * Joins an option's "before" and "after" pictures into pairs, first with
 * first: each pair becomes one entry (the "after", carrying its "before")
 * where the earlier of the two stood. Anything unmatched stays as it is.
 */
export function pairUp(files: OptionFile[]): OptionFile[] {
  const befores = files.filter((f) => f.role === "before" && isImage(f));
  const afters = files.filter((f) => f.role === "after" && isImage(f));
  const pairs = Math.min(befores.length, afters.length);
  if (pairs === 0) return files;
  const out: OptionFile[] = [];
  const placed = new Set<number>();
  for (const f of files) {
    const at = f.role === "before" ? befores.indexOf(f) : f.role === "after" ? afters.indexOf(f) : -1;
    if (at < 0 || at >= pairs) out.push(f);
    else if (!placed.has(at)) {
      placed.add(at);
      out.push({ ...(afters[at] as OptionFile), before: befores[at] });
    }
  }
  return out;
}

/** Pictures this small are sprite art: scale them up with hard pixel edges. */
export const isSmallArt = (width: number | undefined, height: number | undefined) =>
  !!width && !!height && Math.max(width, height) <= 256;

/** The shape every card of one decision gives its media (width over height), from the first file there is. */
export function mediaAspect(files: FileRow[]): number {
  const first = files.find((f) => f.width && f.height);
  if (!first?.width || !first.height) return 4 / 3;
  return Math.min(16 / 9, Math.max(3 / 4, first.width / first.height));
}

/** The comments on one option, or on a decision as a whole, oldest first. */
export function useThread(subjectType: SubjectType, subjectId: string): Comment[] {
  const comments = useCollection("comments");
  return useMemo(
    () =>
      Object.values(comments)
        .filter((c) => c.subject_type === subjectType && c.subject_id === subjectId && !c.deleted_at)
        .sort((a, b) => a.created_at - b.created_at),
    [comments, subjectType, subjectId],
  );
}

/** What the signed-in person may do with a decision. */
export interface Viewer {
  isAsker: boolean;
  /** The question is open and was asked of me: it is my move. */
  mine: boolean;
  canAnswer: boolean;
  /** The question is open and I asked it: I may still reword it. */
  canEdit: boolean;
  canDelete: boolean;
  /** I asked, an answer is in, and I may say it does not settle the question. */
  canReopen: boolean;
}

export function useViewer(decision: Decision): Viewer {
  const me = useMe();
  const open = decision.state === "open";
  const isAsker = decision.created_by === me.user_id;
  // An agent answers only what was asked of it; a person may answer anything they did not ask.
  const barred = me.kind === "agent" && !!decision.asked_id && decision.asked_id !== me.user_id;
  return {
    isAsker,
    mine: open && decision.asked_id === me.user_id,
    canAnswer: open && !isAsker && !barred,
    canEdit: open && isAsker,
    canDelete: open && (isAsker || me.role !== "member"),
    canReopen: !open && isAsker,
  };
}

/** How someone is named in a sentence: a person by name, an agent by handle. */
export function nameOf(member: Member | undefined, fallback: string): string {
  if (!member) return fallback;
  return member.kind === "agent" ? `@${member.handle}` : member.name;
}

export function useMemberName(userId: string | undefined, fallback: string): string {
  return useStore((s) => nameOf(userId ? s.c.members[userId] : undefined, fallback));
}

/** Follows a media query, for the few places where layout cannot be done in CSS. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
  );
}

export const usePhone = () => useMedia("(max-width: 639px)");

/**
 * Gives the focus back to whatever had it when an overlay opened, once the
 * overlay is gone. Call it in the overlay's own component.
 */
export function useReturnFocus() {
  // Read while rendering: by the time effects run, the overlay has taken the focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const leaving = useRef(0);
  useEffect(() => {
    // Mounted again at once (as React does in development): it has not left.
    clearTimeout(leaving.current);
    return () => {
      leaving.current = window.setTimeout(() => {
        if (opener?.isConnected) opener.focus();
      }, 0);
    };
  }, [opener]);
}
