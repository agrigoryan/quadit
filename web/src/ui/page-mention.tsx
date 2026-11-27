// A page named in text, in any form the server reads (lib/page-refs.ts),
// wherever Markdown is drawn (ui/markdown.tsx). It shows the page as it is
// now in the workspace copy, its icon and its title, and opens it in the
// app, as a task's mention opens the task (ui/task-mention.tsx); its card
// says the page's project and when it last changed. A page the copy does
// not hold (in the trash, someone else's private page, one of a project the
// reader may not read) is shown as the words written, quiet.

import type { ReactNode } from "react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useRow, useRowEvenIfGone, useRows, useSlug } from "@/data/selectors";
import type { Doc } from "@/types/docs";
import { docPath } from "@/nav/page-link";
import { Ago } from "@/ui/ago";
import { MentionCard } from "@/ui/mention-card";
import { docTitle, PageIcon } from "@/ui/page-name";

interface Props {
  /** The page, by its id. */
  docId?: string;
  /** Or by its title, as [[Title]] names it. */
  title?: string;
  /** The words written, shown when there is no such page here. */
  children: ReactNode;
}

export function PageMention({ docId, title, children }: Props) {
  const byId = useRow("docs", docId);
  const docs = useRows("docs");
  const doc = byId ?? (title ? pageTitled(docs, title) : undefined);
  const slug = useSlug();
  if (!doc) return <span className="page-mention is-gone">{children}</span>;
  // The space reads the mention aloud, and copies it, as its title after its icon; the layout leaves it out.
  return (
    <MentionCard
      mention={
        <Link to={docPath(slug, doc.id)} className="page-mention">
          <PageIcon doc={doc} className="page-mention-icon" />{" "}
          <span className="page-mention-title">{docTitle(doc)}</span>
        </Link>
      }
    >
      <PageCard doc={doc} />
    </MentionCard>
  );
}

/**
 * The one page with a title, found as the server finds it: that title
 * exactly, or else that title in any case among the pages that are not a
 * database's rows. Two pages of one title name neither.
 */
function pageTitled(docs: Doc[], title: string): Doc | undefined {
  const wanted = title.trim();
  let found = docs.filter((d) => d.title === wanted);
  if (found.length === 0) {
    const lower = wanted.toLowerCase();
    found = docs.filter((d) => d.kind !== "row" && d.title.toLowerCase() === lower);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** What the card says about the page: its title, its project, when it last changed. */
function PageCard({ doc }: { doc: Doc }) {
  const project = useRowEvenIfGone("projects", doc.project_id);
  return (
    <>
      <p className="flex items-start gap-1.5 text-sm leading-snug font-medium">
        <PageIcon doc={doc} className="mt-px" />
        <span className="line-clamp-3 min-w-0">{docTitle(doc)}</span>
      </p>
      <div className="mt-2 flex items-center gap-3 text-xs text-ink-2">
        {project && <span className="min-w-0 truncate">{project.name}</span>}
        <span className="ml-auto shrink-0">
          {t("docs.pageCard.changed")} <Ago ms={doc.updated_at} />
        </span>
      </div>
    </>
  );
}
