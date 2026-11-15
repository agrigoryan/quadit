// Making a label where it is first needed, and the way from a picker to the
// page where a project's labels and statuses are kept.

import { useNavigate } from "react-router";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { send } from "@/lib/mutate";
import { useMe } from "@/lib/selectors";
import { getState, useStore } from "@/lib/store";
import { SWATCHES } from "@/settings/ui/bits";

/**
 * Creates a label in the project (or for the whole workspace when there is
 * none) and answers its id at once: the label shows straight away, and a
 * change that uses it can be sent right behind this one.
 */
export function createLabel(projectId: string | undefined, name: string): string {
  const id = newId();
  const used = Object.values(getState().c.labels).filter((l) => !l.deleted_at).length;
  const color = SWATCHES[(used + 2) % SWATCHES.length];
  const args: Record<string, unknown> = { id, name, color };
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
  const me = useMe();
  const slug = useStore((s) => s.slug);
  const key = useStore((s) => (projectId ? s.c.projects[projectId]?.key : undefined));
  const to = (tab: string) => () =>
    void navigate(key ? `/${slug}/settings/projects/${key}/${tab}` : `/${slug}/settings/projects`);
  return {
    labels: { label: t("pick.manageLabels"), onSelect: to("labels") },
    statuses: me.role !== "member" && key ? { label: t("pick.manageStatuses"), onSelect: to("statuses") } : undefined,
  };
}
