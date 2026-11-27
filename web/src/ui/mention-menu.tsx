// What a text box for Markdown (ui/mention-textarea.tsx) offers to finish
// what is typed: after "@", the people, the tasks and the pages that hold
// it, each section under its heading with a few shown and a row for the
// rest; after "[[", the pages alone. Each row knows what picking it writes
// and how it shows; the box draws the rows inside its list and drives them
// with its keys.

import { Ellipsis } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { pageLink } from "@/lib/page-refs";
import { canSeePage } from "@/data/access";
import { useLiveTasks, useLookup, useLookupEvenIfGone, useMe, useMembers, useRows } from "@/data/selectors";
import type { Dict } from "@/data/store";
import { type Category, isOpenCategory, type Member, type Project, type Status, type Task } from "@/types/core";
import type { Doc } from "@/types/docs";
import { useListening } from "@/data/listening";
import { Avatar } from "@/ui/avatar";
import { StatusIcon } from "@/ui/icons";
import { ListeningDot } from "@/ui/listening-dot";
import { docTitle, PageIcon } from "@/ui/page-name";

/** What is asked for: "@" and what follows it, or "[[" and what follows it, in lower case. */
export interface Asked {
  kind: "mention" | "page";
  query: string;
}

export type SectionName = "people" | "tasks" | "pages";

/** A row of the list: something to write, or the row that shows the rest of its section. */
export type MenuRow = { id: string; view: ReactNode } & ({ insert: string } | { more: SectionName });

export interface MenuSection {
  name: SectionName;
  /** Left out where the list holds one kind of thing only ("[["). */
  heading?: string;
  rows: MenuRow[];
}

/** How many of a section "@" shows until the rest is asked for. */
const SHOWN = 5;
/** How many pages "[[" shows: typing more narrows them. */
const PAGES_SHOWN = 6;

/**
 * The sections offered for what is asked, in their order, empty ones left
 * out. `expanded` names the section whose "more" row was picked: it then
 * shows alone and whole.
 */
export function useMentionMenu(
  asked: Asked | null,
  projectId: string | undefined,
  expanded: SectionName | null,
): MenuSection[] {
  const members = useMembers();
  const tasks = useLiveTasks();
  // A deleted status still has a category: a task on it is open or not by it.
  const statuses = useLookupEvenIfGone("statuses");
  const docs = useRows("docs");
  const docsById = useLookup("docs");
  const projects = useLookupEvenIfGone("projects");
  const me = useMe().user_id;

  return useMemo(() => {
    if (!asked) return [];
    const { query } = asked;
    const pageRow = (doc: Doc, after: string): MenuRow => ({
      id: doc.id,
      insert: pageWritten(doc, projectId) + after,
      view: <PageOffer doc={doc} place={placeOf(doc, projects, docsById, me)} />,
    });
    const found = pagesFor(docs, query, projectId, me);
    if (asked.kind === "page")
      return [{ name: "pages", rows: found.slice(0, PAGES_SHOWN).map((doc) => pageRow(doc, "")) }];

    // A section shows its first few rows and a row for the rest, or all of them once that row is picked.
    const section = <T,>(name: SectionName, items: T[], row: (item: T) => MenuRow): MenuSection => {
      const whole = name === expanded || items.length <= SHOWN;
      const rows = (whole ? items : items.slice(0, SHOWN)).map(row);
      if (!whole) rows.push({ id: `more:${name}`, more: name, view: <MoreOffer n={items.length - SHOWN} /> });
      return { name, heading: t(`mention.${name}`), rows };
    };
    const sections = [
      section(
        "people",
        members.filter((m) => m.handle.startsWith(query) || m.name.toLowerCase().includes(query)),
        (m) => ({ id: m.user_id, insert: `@${m.handle} `, view: <MemberOffer member={m} /> }),
      ),
      section("tasks", tasksFor(tasks, query, projectId, statuses), (task) => ({
        id: task.id,
        insert: `${task.key} `,
        view: <TaskOffer task={task} category={statuses[task.status_id]?.category} />,
      })),
      // Picked from "@", a page is followed by a space, as a person and a task are, to write on.
      section("pages", found, (doc) => pageRow(doc, " ")),
    ].filter((s) => s.rows.length > 0);
    const alone = sections.find((s) => s.name === expanded);
    return alone ? [alone] : sections;
  }, [asked, projectId, expanded, members, tasks, statuses, docs, docsById, projects, me]);
}

/**
 * The tasks whose key or title holds what is typed: the one with that very
 * key first, then the open before the done and the canceled, the project's
 * before others', and the latest changed first.
 */
function tasksFor(tasks: Task[], query: string, projectId: string | undefined, statuses: Dict<Status>): Task[] {
  const exact = (task: Task) => Number(task.key.toLowerCase() === query);
  const open = (task: Task) => Number(isOpenCategory(statuses[task.status_id]?.category));
  const here = (task: Task) => Number(task.project_id === projectId);
  return tasks
    .filter((task) => task.key.toLowerCase().includes(query) || task.title.toLowerCase().includes(query))
    .sort((a, b) => exact(b) - exact(a) || open(b) - open(a) || here(b) - here(a) || b.updated_at - a.updated_at);
}

/**
 * The pages the writer may see whose title holds what is typed: those of
 * the project first, then the latest changed. A database's rows are left
 * out, as when a page is linked to a task.
 */
function pagesFor(docs: Doc[], query: string, projectId: string | undefined, userId: string): Doc[] {
  const here = (d: Doc) => Number(d.project_id === projectId);
  return docs
    .filter((d) => d.kind !== "row" && docTitle(d).toLowerCase().includes(query) && canSeePage(d, userId))
    .sort((a, b) => here(b) - here(a) || b.updated_at - a.updated_at);
}

/**
 * What picking a page writes. Its title goes into the text only where
 * everyone who may read the text may see the page too: a page of the
 * project the text is in, or the workspace's own page that is not private.
 * Any other is written by its id alone, which a reader who may see the page
 * sees by its title, and one who may not sees as the id.
 */
function pageWritten(doc: Doc, projectId: string | undefined): string {
  const everyReader = !doc.owner_id && (!doc.project_id || doc.project_id === projectId);
  return everyReader ? pageLink(docTitle(doc), doc.id) : `doc:${doc.id}`;
}

/** Where a page is, to tell pages of one title apart: its project and the page it is in, or the part of the page tree it is in. */
function placeOf(doc: Doc, projects: Dict<Project>, docs: Dict<Doc>, me: string): string {
  const parent = doc.parent_id ? docs[doc.parent_id] : undefined;
  const parts = [
    doc.project_id ? projects[doc.project_id]?.name : undefined,
    parent && canSeePage(parent, me) ? docTitle(parent) : undefined,
  ].filter((part) => part !== undefined);
  if (parts.length > 0) return parts.join(" › ");
  if (!doc.owner_id) return t("docs.section.team");
  return doc.owner_id === me ? t("docs.section.private") : t("docs.section.shared");
}

interface OptionsProps {
  /** The list's id: the rows' ids, which the box names as the active one, are made from it. */
  id: string;
  sections: MenuSection[];
  /** The index of the highlighted row among all the rows. */
  active: number;
  onActive: (index: number) => void;
  onPick: (row: MenuRow) => void;
}

/** The highlighted row scrolls into view when the keys move it out of sight. */
const keepInView = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest" });

/** The rows of the list, each section a group under its heading, for the box to put inside its listbox. */
export function MentionOptions({ id, sections, active, onActive, onPick }: OptionsProps) {
  let index = 0;
  return sections.map((s) => {
    const rows = s.rows.map((row) => {
      const i = index++;
      return (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- the text box keeps the focus, and its keys pick from the list
        <div
          key={row.id}
          id={`${id}-${i}`}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a list the text box drives with its arrows (aria-activedescendant); a <select> cannot be
          role="option"
          aria-selected={i === active}
          ref={i === active ? keepInView : undefined}
          onMouseEnter={() => onActive(i)}
          onClick={() => onPick(row)}
          className={cx(
            "flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-sm",
            i === active && "bg-hover",
          )}
        >
          {row.view}
        </div>
      );
    });
    if (!s.heading) return rows;
    const headingId = `${id}-${s.name}`;
    return (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of options inside a listbox; <optgroup> lives only in a <select>
      <div key={s.name} role="group" aria-labelledby={headingId}>
        <div id={headingId} role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-ink-3">
          {s.heading}
        </div>
        {rows}
      </div>
    );
  });
}

/** A person or an agent; beside an agent, whether anything is listening for its work right now. */
function MemberOffer({ member }: { member: Member }) {
  const on = useListening()(member);
  return (
    <>
      <Avatar member={member} size="sm" />
      <span className="min-w-0 flex-1 truncate">{member.name}</span>
      <span className="text-xs text-ink-3">@{member.handle}</span>
      {on !== undefined && <ListeningDot on={on} />}
    </>
  );
}

/** A task, as a mention of it shows: its status, its key and its title. */
function TaskOffer({ task, category }: { task: Task; category: Category | undefined }) {
  return (
    <>
      <span className="flex w-4 shrink-0 justify-center">
        <StatusIcon category={category ?? "backlog"} />
      </span>
      <span className="shrink-0 text-xs text-ink-3 tnum">{task.key}</span>
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
    </>
  );
}

/** A page, with where it is under its title. */
function PageOffer({ doc, place }: { doc: Doc; place: string }) {
  return (
    <>
      <PageIcon doc={doc} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{docTitle(doc)}</span>
        <span className="truncate text-xs text-ink-3">{place}</span>
      </span>
    </>
  );
}

/** The row that shows the rest of a section. */
function MoreOffer({ n }: { n: number }) {
  return (
    <>
      <Ellipsis className="size-4 shrink-0 text-ink-3" aria-hidden />
      <span className="text-ink-2">{t("mention.more", { n })}</span>
    </>
  );
}
