// The project a page is tied to, in the bar above the page: set it, change
// it or clear it, from the list tasks pick a project from. Under the list,
// what the choice means and which pages go along.

import { CircleSlash } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCan } from "@/lib/access";
import { useLookupEvenIfGone, useProjects, useRowEvenIfGone } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { setProject } from "@/docs/actions";
import { countBelow, sameProjectBelow } from "@/docs/data";
import { NoProjectGlyph } from "@/docs/project-mark";
import { useDocsStore } from "@/docs/store";
import type { Doc } from "@/lib/types-docs";
import { PickerList } from "@/ui/picker";
import { projectItems } from "@/tasks/property-picker";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Tooltip } from "@/ui/tooltip";

const NONE = "none";

/** Sub-pages as a person counts them: not a database's rows, not the trash. */
const counted = (pages: Doc[]) => pages.filter((d) => d.kind !== "row" && !d.deleted_at).length;

export function ProjectField({ doc }: { doc: Doc }) {
  // An archived project is still the page's.
  const project = useRowEvenIfGone("projects", doc.project_id);
  const mayEdit = useCan().edit(doc.project_id);
  const [open, setOpen] = useState(false);
  const name = project?.name ?? t("docs.project.none");
  const label = project ? `${t("prop.project")}: ${name}` : name;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" aria-label={label} disabled={!mayEdit} className="gap-1.5 px-2">
            {project ? <ProjectGlyph project={project} /> : <NoProjectGlyph />}
            <span className={cx("max-w-36 truncate max-xl:hidden", !project && "text-ink-3")}>{name}</span>
          </Button>
        </PopoverTrigger>
      </Tooltip>
      {open && (
        <PopoverContent align="end" aria-label={label} className="p-0">
          <ProjectChoices doc={doc} close={() => setOpen(false)} />
        </PopoverContent>
      )}
    </Popover>
  );
}

/** The list inside the popover. It reads every page only while it is open. */
function ProjectChoices({ doc, close }: { doc: Doc; close: () => void }) {
  const projects = useProjects();
  const items = useMemo(
    () => [
      { id: NONE, label: t("docs.project.none"), icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden /> },
      ...projectItems(projects),
    ],
    [projects],
  );

  function pick(id: string) {
    const to = projects.find((p) => p.id === id);
    const along = counted(setProject(doc.id, to ? to.id : null));
    if (along > 0) toast.info(t("docs.project.movedAlong", { n: along }));
    close();
  }

  return (
    <>
      <PickerList
        items={items}
        value={doc.project_id ?? NONE}
        label={t("docs.project.set")}
        placeholder={t("docs.project.set")}
        onPick={pick}
      />
      <ProjectNotes doc={doc} />
    </>
  );
}

/** What changing the project does: who sees the page, which pages inside go along, and what a mirrored file makes of it. */
function ProjectNotes({ doc }: { doc: Doc }) {
  // The server takes trashed pages along too (and walks through them); only those not in the trash are counted.
  const docs = useLookupEvenIfGone("docs");
  const source = useDocsStore((s) => s.meta[doc.id]?.source);
  const along = useMemo(() => counted(sameProjectBelow(docs, doc)), [docs, doc]);
  const stay = useMemo(() => countBelow(docs, doc.id), [docs, doc.id]) - along;
  return (
    <div className="flex w-60 flex-col gap-1.5 border-t border-line px-3 py-2.5 text-xs text-ink-2">
      <p>{t("docs.project.note")}</p>
      {along > 0 && <p>{t("docs.project.along", { n: along })}</p>}
      {stay > 0 && <p>{t("docs.project.stay", { n: stay })}</p>}
      {source && (
        <p>
          {t(source.root_doc_id === doc.id ? "docs.project.sourceRoot" : "docs.project.source", {
            repo: repoName(source.repo),
          })}
        </p>
      )}
    </div>
  );
}

/** "docs" for ".../owner/docs.git". */
const repoName = (repo: string) =>
  repo
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop() || repo;
