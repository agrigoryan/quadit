// Making a label where it is first needed, and the way from a picker to the
// page where a project's labels and statuses are kept.

import type { Changes } from "@/lib/changes.gen";
import { useNavigate } from "react-router";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { send } from "@/lib/mutate";
import { useCan } from "@/lib/access";
import { getRows, useRowEvenIfGone, useSlug } from "@/lib/selectors";
import { SWATCHES } from "@/lib/swatches";

/**
 * Creates a label in the project (or for the whole workspace when there is
 * none) and answers its id at once: the label shows straight away, and a
 * change that uses it can be sent right behind this one.
 */
export function createLabel(projectId: string | undefined, name: string): string {
  const id = newId();
  const used = getRows("labels").length;
  const color = SWATCHES[(used + 2) % SWATCHES.length];
  const args: Changes["label.create"] = { id, name, color };
  if (projectId) args.project = projectId;
  send({ type: "label.create", args }, (tx) => tx.insert("labels", { id, project_id: projectId, name, color }));
  return id;
}

export const createLabelText = (name: string) => t("pick.createLabel", { name });

export interface ManageLink {
  label: string;
  onSelect: () => void;
}

/**
 * The "Manage labels" and "Manage statuses" rows of a picker. Statuses are
 * for admins, who alone may change them; without a project in view both
 * lead to the list of projects.
 */
export function useManageLinks(projectId: string | undefined): {
  labels: ManageLink;
  statuses: ManageLink | undefined;
} {
  const navigate = useNavigate();
  const can = useCan();
  const slug = useSlug();
  // A task in an archived project still leads to that project's settings.
  const key = useRowEvenIfGone("projects", projectId)?.key;
  const to = (tab: string) => () =>
    void navigate(key ? `/${slug}/settings/projects/${key}/${tab}` : `/${slug}/settings/projects`);
  return {
    labels: { label: t("pick.manageLabels"), onSelect: to("labels") },
    statuses: can.administer && key ? { label: t("pick.manageStatuses"), onSelect: to("statuses") } : undefined,
  };
}
