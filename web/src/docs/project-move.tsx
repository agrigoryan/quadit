// Bringing pages that are in no project into one: pick a page, and it
// comes with the pages under it.

import { useMemo } from "react";
import { t } from "@/lib/i18n";
import type { Project } from "@/types/core";
import { setProject } from "@/docs/actions";
import { useLookupEvenIfGone } from "@/data/selectors";
import { countBelow, docTitle, useLinkablePages } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { Picker } from "@/ui/picker";
import { Button } from "@/ui/button";

/**
 * A button that lists the pages in no project; each pick moves one into the
 * project. Nothing when every page has one. `compact` draws it to sit in a
 * header beside the tree's other buttons.
 */
export function MovePagesHere({ project, compact }: { project: Project; compact?: boolean }) {
  // Counted as the project field counts them: through trashed pages too, the trash itself left out (countBelow).
  const docs = useLookupEvenIfGone("docs");
  const pages = useLinkablePages();
  const items = useMemo(
    () =>
      pages
        .filter((d) => !d.project_id && !d.memory_of)
        .map((d) => {
          const inside = countBelow(docs, d.id);
          return {
            id: d.id,
            label: docTitle(d),
            icon: <PageIcon doc={d} />,
            hint: inside ? t("docs.projectEmpty.inside", { n: inside }) : undefined,
          };
        }),
    [pages, docs],
  );
  if (items.length === 0) return null;
  return (
    <Picker
      multiple
      items={items}
      label={t("docs.projectEmpty.movePick")}
      placeholder={t("docs.projectEmpty.movePick")}
      onPick={(id) => void setProject(id, project.id)}
      align="center"
    >
      <Button {...(compact ? { variant: "ghost", size: "sm" } : {})}>{t("docs.projectEmpty.move")}</Button>
    </Picker>
  );
}
