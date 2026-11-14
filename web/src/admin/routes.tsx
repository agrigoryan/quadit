import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { t } from "@/lib/i18n";
import { EmptyState } from "@/ui/empty";
import { AdminAuditPage } from "@/admin/audit";
import { BackupsPage } from "@/admin/backups";
import { AdminFrame } from "@/admin/frame";
import { GeneralPage } from "@/admin/general";
import { HealthPage } from "@/admin/health";
import { LimitsPage } from "@/admin/limits";
import { MailPage } from "@/admin/mail";
import { SignInPage } from "@/admin/sign-in";
import { StoragePage } from "@/admin/storage";
import { UsersPage } from "@/admin/users";
import { WorkspacesPage } from "@/admin/workspaces";

const wide = typeof matchMedia === "function" ? matchMedia("(min-width: 768px)") : null;

/** At /admin a phone shows the list of pages; a wider screen opens the first page beside it. */
function Root() {
  const [isWide, setWide] = useState(wide?.matches ?? true);
  useEffect(() => {
    const on = () => setWide(wide?.matches ?? true);
    wide?.addEventListener("change", on);
    return () => wide?.removeEventListener("change", on);
  }, []);
  return isWide ? <Navigate to="general" replace /> : null;
}

/** The install's admin area, at /admin. For the people who run the install. Loaded on demand. */
export default function AdminRoutes() {
  return (
    <AdminFrame>
      <Routes>
        <Route index element={<Root />} />
        <Route path="general" element={<GeneralPage />} />
        <Route path="sign-in" element={<SignInPage />} />
        <Route path="mail" element={<MailPage />} />
        <Route path="storage" element={<StoragePage />} />
        <Route path="limits" element={<LimitsPage />} />
        <Route path="backups" element={<BackupsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="audit" element={<AdminAuditPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="*" element={<EmptyState title={t("common.notFound")} hint={t("common.notFoundHint")} />} />
      </Routes>
    </AdminFrame>
  );
}
