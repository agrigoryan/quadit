import { useMemo } from "react";
import { workspacePath } from "@/data/api";
import { t } from "@/lib/i18n";
import { useLookupEvenIfGone, useSlug } from "@/data/selectors";
import { AuditLog } from "@/admin/audit-log";
import { useSettingsBase } from "@/settings/base";

/** This workspace's slice of the audit log, for its admins. */
export function WorkspaceAuditPage() {
  const slug = useSlug();
  const base = useSettingsBase();
  // Removed members too: what they did is still in the log.
  const members = useLookupEvenIfGone("members");
  const actors = useMemo(
    () =>
      Object.values(members)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1))
        .map((m) => ({ id: m.user_id, name: m.kind === "agent" ? `${m.name} (@${m.handle})` : m.name })),
    [members],
  );
  return (
    <AuditLog
      title={t("audit.title")}
      lead={t("audit.workspaceLead")}
      back={base}
      endpoint={workspacePath(slug, "/audit")}
      actors={actors}
    />
  );
}
