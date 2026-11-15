import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { AuditLog } from "@/admin/audit-log";
import { useAdminUsers } from "@/admin/users";
import { useAdminWorkspaces } from "@/admin/workspaces";

/** The whole install's audit log. */
export function AdminAuditPage() {
  // The filters work without these lists; they only add names to pick from.
  const users = useAdminUsers();
  const workspaces = useAdminWorkspaces();
  const actors = useMemo(
    () =>
      (users.data ?? []).map((u) => ({
        id: u.id,
        name: u.kind === "agent" ? `${u.name} (${t("common.agent").toLowerCase()})` : u.name,
      })),
    [users.data],
  );
  const spaces = useMemo(() => (workspaces.data ?? []).map((w) => ({ id: w.id, name: w.name })), [workspaces.data]);
  return (
    <AuditLog
      title={t("audit.title")}
      lead={t("audit.adminLead")}
      back="/admin"
      endpoint="/api/v1/admin/audit"
      actors={actors}
      workspaces={spaces}
    />
  );
}
