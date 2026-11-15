import { useMemo } from "react";
import { t } from "@/lib/i18n";
import { AuditLog } from "@/admin/audit-log";
import { fetchUsers } from "@/admin/users";
import { fetchWorkspaces } from "@/admin/workspaces";
import { useLoad } from "@/lib/use-load";

/** The whole install's audit log. */
export function AdminAuditPage() {
  // The filters work without these lists; they only add names to pick from.
  const users = useLoad(fetchUsers, []);
  const workspaces = useLoad(fetchWorkspaces, []);
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
