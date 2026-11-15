// What the decision log reads from the store: every decision joined to its
// task and project, the filters over them, and the standing preferences.
// Nothing here asks the server; the store is kept live by the feed.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import type { Dict } from "@/lib/store";
import type { Decision, DecisionOption, Outcome, Project, Task } from "@/lib/types";
import type { Preference } from "@/insights/lib/types";

export interface Entry {
  decision: Decision;
  task: Task;
  project: Project | undefined;
  /** When it was answered, or asked if it is still open: what the log is ordered by. */
  at: number;
  /** Everything the search box looks through, lower-cased. */
  text: string;
}

export type StateFilter = "all" | "open" | "picked" | "sent_back";
export const STATES: StateFilter[] = ["all", "open", "picked", "sent_back"];

export interface Filters {
  q: string;
  state: StateFilter;
  /** A project id, a user id, or "" for any. */
  project: string;
  asked: string;
  by: string;
}

export const noFilters: Filters = { q: "", state: "all", project: "", asked: "", by: "" };

export const isFiltered = (f: Filters) => f.q.trim() !== "" || f.state !== "all" || !!f.project || !!f.asked || !!f.by;

/** Every live decision on a live task, newest first. */
export function useEntries(): Entry[] {
  const decisions = useCollection("decisions");
  const tasks = useCollection("tasks");
  const projects = useCollection("projects");
  return useMemo(() => {
    const out: Entry[] = [];
    for (const decision of Object.values(decisions)) {
      if (decision.deleted_at) continue;
      const task = tasks[decision.task_id];
      if (!task || task.deleted_at) continue;
      const words = [
        decision.question,
        decision.details,
        decision.outcome_note,
        decision.unclear_note,
        decision.recommendation,
        task.key,
        task.title,
        ...(decision.options ?? []).flatMap((o) => [o.label, o.description]),
      ];
      out.push({
        decision,
        task,
        project: projects[task.project_id],
        at: decision.decided_at ?? decision.created_at,
        text: words.filter(Boolean).join("\n").toLowerCase(),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [decisions, tasks, projects]);
}

/** Whether an entry passes the filters; `skip` leaves one filter out (to count what it would show). */
export function matches(entry: Entry, f: Filters, skip?: keyof Filters): boolean {
  const d = entry.decision;
  if (skip !== "state" && f.state !== "all" && d.state !== f.state) return false;
  if (skip !== "project" && f.project && entry.task.project_id !== f.project) return false;
  if (skip !== "asked" && f.asked && d.asked_id !== f.asked) return false;
  if (skip !== "by" && f.by && d.decided_by !== f.by) return false;
  if (skip !== "q") {
    for (const word of f.q.toLowerCase().split(/\s+/)) {
      if (word && !entry.text.includes(word)) return false;
    }
  }
  return true;
}

/** How many entries each value of one field has, among those the other filters let through. */
export function countBy(entries: Entry[], f: Filters, field: "state" | "project" | "asked" | "by"): Dict<number> {
  const out: Dict<number> = {};
  const keyOf = (e: Entry) =>
    field === "state"
      ? e.decision.state
      : field === "project"
        ? e.task.project_id
        : field === "asked"
          ? e.decision.asked_id
          : e.decision.decided_by;
  for (const entry of entries) {
    if (!matches(entry, f, field)) continue;
    const key = keyOf(entry);
    if (key) out[key] = (out[key] ?? 0) + 1;
    out.all = (out.all ?? 0) + 1;
  }
  return out;
}

export const optionsOf = (decision: Decision): DecisionOption[] => decision.options ?? [];

export function pickedOption(decision: Decision): DecisionOption | undefined {
  return optionsOf(decision).find((o) => o.id === decision.picked_option_id);
}

/** The outcome of an answered decision, also for rows written before outcomes were kept. */
export function outcomeOf(decision: Decision): Outcome {
  if (decision.outcome) return decision.outcome;
  const sentBack = decision.state === "sent_back";
  if (decision.kind === "approval") return sentBack ? "declined" : "approved";
  return sentBack ? "none" : "as_is";
}

/** The answer as a short phrase: the option picked, "Approved", "None of the options". */
export function answerText(decision: Decision): string {
  const outcome = outcomeOf(decision);
  if (outcome === "approved" || outcome === "declined") return t(`decision.outcome.${outcome}`);
  return pickedOption(decision)?.label ?? t("prefs.prefill.none");
}

/** A rule to start a preference from: the question, its answer and the note, as one line. */
export function prefillRule(decision: Decision): string {
  const question = decision.question.trim();
  const answer = answerText(decision).replace(/[.\s]+$/, "");
  const note = decision.outcome_note?.trim();
  return note ? t("prefs.prefill.note", { question, answer, note }) : t("prefs.prefill", { question, answer });
}

export interface Preferences {
  active: Preference[];
  retired: Preference[];
  /** The live preference made from each decision, by decision id. */
  byDecision: Dict<Preference>;
}

/** Standing preferences, newest first; the retired ones apart. */
export function usePreferences(): Preferences {
  const rows = useCollection("preferences");
  return useMemo(() => {
    const all = (Object.values(rows) as unknown as Preference[])
      .filter((p) => !p.deleted_at)
      .sort((a, b) => b.created_at - a.created_at);
    const byDecision: Dict<Preference> = {};
    for (const p of all) if (p.decision_id && !p.retired_at) byDecision[p.decision_id] ??= p;
    return { active: all.filter((p) => !p.retired_at), retired: all.filter((p) => p.retired_at), byDecision };
  }, [rows]);
}
