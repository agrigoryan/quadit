// "Mentioned in": the tasks and pages whose text names this task, or one of
// its questions, so a reader can follow the thread back. The server keeps
// these references and says what each source is called; they come with the
// task's detail. The task's own are listed in the panel, a question's under
// that question.

import { useEffect } from "react";
import { FileText } from "lucide-react";
import { Link } from "react-router";
import { create } from "zustand";
import { api, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { getState, useStore } from "@/lib/store";
import type { Task } from "@/lib/types";
import { Section } from "@/detail/section";
import { PageIcon } from "@/docs/page-icon";
import type { Doc } from "@/docs/types";
import { useTaskLink } from "@/tasks/task-row";
import { StatusIcon } from "@/ui/icons";

/** One reference as the server sends it: what is mentioned, and the task or page the mention is in. */
interface Ref {
  from_scope_type: string;
  from_scope_id: string;
  /** "task", or "decision" when it is one of the task's questions that is named. */
  to_type: string;
  to_id: string;
  /** What the source is called: the page's or the task's title. */
  title?: string;
  /** The task's key, when the mention is in a task or one of its comments. */
  key?: string;
}

export interface Mention {
  kind: "task" | "doc";
  /** The id of the task or page the mention is in. */
  id: string;
  title: string;
  key?: string;
  /** The question that is mentioned, when it is not the task as a whole. */
  decisionId?: string;
}

const NONE: Mention[] = [];

/** What mentions each opened task, by task id. */
const useMentions = create<Record<string, Mention[]>>(() => ({}));

/** Each source once per thing it mentions, however often it names it; a task naming itself is not news. */
function read(refs: Ref[], taskId: string): Mention[] {
  const seen = new Set<string>();
  const list: Mention[] = [];
  for (const ref of refs) {
    const kind = ref.from_scope_type === "doc" ? "doc" : ref.from_scope_type === "task" ? "task" : null;
    const decisionId = ref.to_type === "decision" ? ref.to_id : undefined;
    const once = `${decisionId ?? ""}:${ref.from_scope_id}`;
    if (!kind || ref.from_scope_id === taskId || seen.has(once)) continue;
    seen.add(once);
    list.push({ kind, id: ref.from_scope_id, title: ref.title ?? "", key: ref.key, decisionId });
  }
  return list;
}

/** Asks where a task is mentioned: when it opens, and whenever the live stream comes back. */
function useLoadMentions(taskId: string) {
  const live = useStore((s) => s.stream === "live");
  useEffect(() => {
    const ctl = new AbortController();
    api
      .get<{ mentioned_in?: Ref[] }>(ws(getState().slug, `/tasks/${taskId}?raw=1`), ctl.signal)
      .then((raw) => useMentions.setState({ [taskId]: read(raw.mentioned_in ?? [], taskId) }))
      .catch(() => {});
    return () => ctl.abort();
  }, [taskId, live]);
}

const rowStyle = "group relative -mx-1.5 flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-hover max-md:h-10";
const linkStyle = "min-w-0 flex-1 truncate py-1.5 outline-none after:absolute after:inset-0 after:content-['']";

function TaskMention({ mention }: { mention: Mention }) {
  const task = useStore((s) => s.c.tasks[mention.id]);
  const status = useStore((s) => (task ? s.c.statuses[task.status_id] : undefined));
  const key = task?.key ?? mention.key ?? "";
  const link = useTaskLink({ key });
  return (
    <li className={rowStyle}>
      <span className="flex size-6 shrink-0 items-center justify-center">{status && <StatusIcon category={status.category} title={status.name} />}</span>
      <span className="shrink-0 text-xs text-ink-3 tnum">{key}</span>
      <Link {...link} className={linkStyle}>
        {task?.title ?? mention.title}
      </Link>
    </li>
  );
}

function DocMention({ mention }: { mention: Mention }) {
  const slug = useSlug();
  const doc = useStore((s) => s.c.docs[mention.id]) as unknown as Doc | undefined;
  return (
    <li className={rowStyle}>
      <span className="flex size-6 shrink-0 items-center justify-center">{doc ? <PageIcon doc={doc} /> : <FileText className="size-4 text-ink-3" aria-hidden />}</span>
      <span className="shrink-0 text-xs text-ink-3">{t("detail.mentions.page")}</span>
      <Link to={`/${slug}/docs/${mention.id}`} className={linkStyle}>
        {doc?.title || mention.title || t("detail.mentions.untitled")}
      </Link>
    </li>
  );
}

function Rows({ mentions }: { mentions: Mention[] }) {
  return (
    <ul>
      {mentions.map((m) => (m.kind === "task" ? <TaskMention key={m.id} mention={m} /> : <DocMention key={m.id} mention={m} />))}
    </ul>
  );
}

/** The panel's section: what mentions the task itself. Draws nothing when nothing does. */
export function MentionedIn({ task }: { task: Task }) {
  useLoadMentions(task.id);
  const all = useMentions((s) => s[task.id]) ?? NONE;
  const mentions = all.filter((m) => !m.decisionId);
  if (mentions.length === 0) return null;
  return (
    <Section title={t("detail.mentions")} meta={<span className="text-xs text-ink-3 tnum">{mentions.length}</span>}>
      <Rows mentions={mentions} />
    </Section>
  );
}

/** Under a question: the tasks and pages that mention that question. Draws nothing when none does. */
export function DecisionMentions({ taskId, decisionId }: { taskId: string; decisionId: string }) {
  const all = useMentions((s) => s[taskId]) ?? NONE;
  const mentions = all.filter((m) => m.decisionId === decisionId);
  if (mentions.length === 0) return null;
  return (
    <section aria-label={t("detail.mentions.decision")} className="mt-2">
      <h4 className="text-xs font-medium text-ink-2">
        {t("detail.mentions.decision")} <span className="font-normal text-ink-3 tnum">{mentions.length}</span>
      </h4>
      <Rows mentions={mentions} />
    </section>
  );
}
