// The palette's pages for making a label or a status: the box takes the
// name, and Enter makes it in the project in view.

import { Plus } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { CATEGORIES, type Project } from "@/types/core";
import type { MakePage } from "@/palette/palette-commands";
import { Group, Item, Note } from "@/palette/palette-rows";
import { createStatus } from "@/tasks/add-status";
import { createLabel, createLabelText } from "@/tasks/manage";
import { StatusIcon } from "@/ui/icons";

export const makeTitle: Record<MakePage, () => string> = {
  "new-label": () => t("palette.make.labelName"),
  "new-status": () => t("palette.make.statusName"),
};

interface Props {
  page: MakePage;
  project: Project;
  query: string;
  /** Runs the choice and closes the palette. */
  run: (action: () => void) => void;
}

export function MakePageRows({ page, project, query, run }: Props) {
  const name = query.trim();
  if (!name)
    return (
      <Note>
        {t(page === "new-label" ? "palette.make.labelHint" : "palette.make.statusHint", { project: project.name })}
      </Note>
    );

  if (page === "new-label") {
    return (
      <Group heading={project.name}>
        <Item
          value="make:label"
          icon={<Plus />}
          onSelect={() =>
            run(() => {
              createLabel(project.id, name);
              toast.info(t("palette.make.labelDone", { name }));
            })
          }
        >
          {createLabelText(name)}
        </Item>
      </Group>
    );
  }

  // A status needs to say what kind it is: one row for each kind.
  return (
    <Group heading={t("palette.make.statusPick", { name })}>
      {CATEGORIES.map((category) => (
        <Item
          key={category}
          value={`make:status:${category}`}
          icon={<StatusIcon category={category} />}
          onSelect={() =>
            run(() => {
              createStatus(project, name, category)
                .then(() => toast.info(t("palette.make.statusDone", { name })))
                .catch((err: unknown) => toast.error(errorMessage(err)));
            })
          }
        >
          {t(`category.${category}`)}
        </Item>
      ))}
    </Group>
  );
}
