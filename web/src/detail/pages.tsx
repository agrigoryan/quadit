// "Pages": the pages a task points at and that point at it. A page is
// linked to the task (a link of kind doc, made here or with `quadit link`),
// mentions the task in its text, or is mentioned in the task's text or
// comments. Each is listed once, and a linked one can be taken off.

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import { useLookup, useRows, useSlug } from "@/data/selectors";
import { useMentionsByTask, useTaskMentions } from "@/data/task-detail";
import type { Task } from "@/types/core";
import type { Doc } from "@/types/docs";
import { useTaskLinks } from "@/detail/data";
import { Section } from "@/detail/section";
import { docPath } from "@/nav/page-link";
import { PageIcon, docTitle } from "@/ui/page-name";
import { linkPage, removeLink } from "@/tasks/actions";
import { IconButton } from "@/ui/button";
import { Picker, type PickerItem } from "@/ui/picker";

/** One page beside the task, and how it got there. */
export interface TaskPage {
  doc: Doc;
  /** The link that ties it to the task, when one does; only such a page can be taken off. */
  linkId?: string;
  /** Why it is listed when it is not linked. */
  how?: "mentionsTask" | "mentionedHere";
}

/**
 * The task's pages, each once: linked first, then those that mention the
 * task, then those it mentions. Only pages in the copy, which holds those
 * the reader may see and are not in the trash.
 */
export function useTaskPages(taskId: string): TaskPage[] {
  const links = useTaskLinks(taskId);
  const mentionedIn = useTaskMentions(taskId);
  const mentions = useMentionsByTask(taskId);
  const docs = useLookup("docs");
  return useMemo(() => {
    const seen = new Map<string, TaskPage>();
    const add = (docId: string | undefined, how: Omit<TaskPage, "doc">) => {
      const doc = docId ? docs[docId] : undefined;
      if (doc && !seen.has(doc.id)) seen.set(doc.id, { doc, ...how });
    };
    for (const link of links) if (link.kind === "doc") add(link.ref, { linkId: link.id });
    for (const ref of mentionedIn) {
      if (ref.from_scope_type === "doc" && ref.to_type === "task") add(ref.from_scope_id, { how: "mentionsTask" });
    }
    // A link's own reference is the link above, which this copy keeps current.
    for (const ref of mentions) {
      if (ref.to_type === "doc" && ref.from_type !== "link") add(ref.to_id, { how: "mentionedHere" });
    }
    return [...seen.values()];
  }, [links, mentionedIn, mentions, docs]);
}

const rowStyle =
  "group relative -mx-1.5 flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-hover max-md:h-10";
const linkStyle = "min-w-0 flex-1 truncate py-1.5 outline-none after:absolute after:inset-0 after:content-['']";

function PageRow({ page, readOnly }: { page: TaskPage; readOnly: boolean }) {
  const slug = useSlug();
  const doc = page.doc;
  const title = docTitle(doc);
  return (
    <li className={rowStyle}>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <PageIcon doc={doc} />
      </span>
      <Link to={docPath(slug, doc.id)} className={linkStyle}>
        {title}
      </Link>
      {page.how && <span className="shrink-0 text-xs text-ink-3">{t(`detail.pages.${page.how}`)}</span>}
      {page.linkId && !readOnly && (
        <IconButton
          label={t("detail.pages.remove", { title })}
          size="sm"
          className="relative z-[1] shrink-0 text-ink-3 max-md:size-8"
          onClick={() => page.linkId && removeLink(page.linkId)}
        >
          <X className="size-3" />
        </IconButton>
      )}
    </li>
  );
}

interface AddProps {
  task: Task;
  /** The pages already listed, which the list does not offer. */
  listed: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Add a page": the pages the reader may see, searched by title. A database's rows are left out. */
function AddPage({ task, listed, open, onOpenChange }: AddProps) {
  const docs = useRows("docs");
  const items = useMemo<PickerItem[]>(
    () =>
      docs
        .filter((d) => d.kind !== "row" && !listed.has(d.id))
        .sort((a, b) => b.updated_at - a.updated_at)
        .map((d) => ({ id: d.id, label: docTitle(d), icon: <PageIcon doc={d} /> })),
    [docs, listed],
  );
  return (
    <Picker
      items={items}
      label={t("detail.pages.add")}
      placeholder={t("detail.pages.search")}
      empty={t("detail.pages.none")}
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      onPick={(docId) => linkPage(task, docId)}
    >
      <IconButton label={t("detail.pages.add")} size="sm" className="max-md:size-9">
        <Plus className="size-3.5" />
      </IconButton>
    </Picker>
  );
}

interface Props {
  task: Task;
  pages: TaskPage[];
  /** Open with the list of pages to add from (the section was opened to add the first one). */
  startAdding?: boolean;
  /** Called when that list closes with nothing in the section. */
  onEmptyClose?: () => void;
}

/** The task's "Pages" section, with the way to link another page. */
export function Pages({ task, pages, startAdding, onEmptyClose }: Props) {
  const readOnly = !useCan().editTask(task);
  const [adding, setAdding] = useState(!!startAdding);
  const listed = useMemo(() => new Set(pages.map((p) => p.doc.id)), [pages]);
  return (
    <Section
      title={t("detail.pages")}
      meta={pages.length > 0 && <span className="text-xs text-ink-3 tnum">{pages.length}</span>}
      action={
        !readOnly && (
          <AddPage
            task={task}
            listed={listed}
            open={adding}
            onOpenChange={(open) => {
              setAdding(open);
              if (!open && pages.length === 0) onEmptyClose?.();
            }}
          />
        )
      }
    >
      {pages.length > 0 && (
        <ul>
          {pages.map((page) => (
            <PageRow key={page.doc.id} page={page} readOnly={readOnly} />
          ))}
        </ul>
      )}
    </Section>
  );
}
