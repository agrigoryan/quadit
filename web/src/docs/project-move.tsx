// Bringing pages that are in no project into one: pick a page, and it
// comes with the pages under it.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import type { Project } from "@/lib/types";
import { setProject } from "@/docs/actions";
import { countBelow, docTitle, useDocs, useLinkablePages } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { ChoicePicker } from "@/tasks/choice-list";
import { Button } from "@/ui/button";

/** A button that lists the pages in no project; each pick moves one into the project. Nothing when every page has one. */
export function MovePagesHere({ project }: { project: Project }) {
  const docs = useDocs();
  const pages = useLinkablePages();
  const items = useMemo(
    () =>
      pages
        .filter((d) => !d.project_id && !d.memory_of)
        .map((d) => {
          const inside = countBelow(docs, d.id);
          return { id: d.id, label: docTitle(d), icon: <PageIcon doc={d} />, hint: inside ? t("docs.projectEmpty.inside", { n: inside }) : undefined };
        }),
    [pages, docs],
  );
  if (items.length === 0) return null;
  return (
    <ChoicePicker multiple items={items} label={t("docs.projectEmpty.movePick")} placeholder={t("docs.projectEmpty.movePick")} onPick={(id) => void setProject(id, project.id)} align="center">
      <Button>{t("docs.projectEmpty.move")}</Button>
    </ChoicePicker>
  );
}
