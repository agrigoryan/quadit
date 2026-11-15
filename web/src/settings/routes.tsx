import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Link, Navigate, Route, Routes } from "react-router";
import { t } from "@/lib/i18n";
import { usePageTitle } from "@/lib/ui-state";
import { NotFoundPage } from "@/ui/not-found";
import { AgentPage } from "@/settings/agents/agent";
import { AgentsPage } from "@/settings/agents/agents";
import { WorkspaceAuditPage } from "@/settings/audit/audit-page";
import { IntegrationsPage } from "@/settings/automation/integrations";
import { RulesPage } from "@/settings/automation/rules";
import { SourcesPage } from "@/settings/automation/sources";
import { WebhooksPage } from "@/settings/automation/webhooks";
import { useIsAdmin, useSettingsBase } from "@/settings/base";
import { ImportPage } from "@/settings/import/import-page";
import { NotificationsPage } from "@/settings/me/notifications";
import { ProfilePage } from "@/settings/me/profile";
import { SecurityPage } from "@/settings/me/security";
import { MyTokensPage } from "@/settings/me/tokens";
import { ProjectPage } from "@/settings/projects/project";
import { ProjectsPage } from "@/settings/projects/projects";
import { SecretsPage } from "@/settings/secrets/secrets";
import { settingsGroups } from "@/settings/pages";
import { NavLayout } from "@/ui/page-layout";
import { GeneralPage } from "@/settings/workspace/general";
import { MembersPage } from "@/settings/workspace/members";
import { EmptyState } from "@/ui/empty";

const wide = typeof matchMedia === "function" ? matchMedia("(min-width: 768px)") : null;

/** At the root a phone shows the list of pages; a wider screen opens the first page beside it. */
function Root({ first }: { first: string }) {
  const [isWide, setWide] = useState(wide?.matches ?? true);
  useEffect(() => {
    const on = () => setWide(wide?.matches ?? true);
    wide?.addEventListener("change", on);
    return () => wide?.removeEventListener("change", on);
  }, []);
  return isWide ? <Navigate to={first} replace /> : null;
}

/** What a member sees at the address of a page only admins may use: why, and where their own settings are. */
function AdminsOnly({ base }: { base: string }) {
  return (
    <EmptyState
      icon={<Lock />}
      title={t("settings.adminsOnly.title")}
      hint={t("settings.adminsOnly.hint")}
      action={
        <Link
          to={`${base}/me/profile`}
          className="text-sm font-medium text-accent-text underline-offset-2 hover:underline"
        >
          {t("settings.adminsOnly.mine")}
        </Link>
      }
    />
  );
}

/** Everything under /:ws/settings. Loaded on demand. */
export default function SettingsRoutes() {
  usePageTitle(t("settings.title"));
  const base = useSettingsBase();
  const admin = useIsAdmin();
  const groups = settingsGroups(admin).map((group) => ({
    title: t(group.title),
    items: group.pages.map((page) => ({ to: page.path, label: t(page.label), icon: page.icon })),
  }));
  const forAdmins = (page: React.ReactNode) => (admin ? page : <AdminsOnly base={base} />);
  return (
    <NavLayout base={base} label={t("settings.title")} groups={groups}>
      <Routes>
        <Route index element={<Root first={admin ? "general" : "me/profile"} />} />
        <Route path="general" element={forAdmins(<GeneralPage />)} />
        <Route path="members" element={<MembersPage />} />
        <Route path="import" element={forAdmins(<ImportPage />)} />
        <Route path="audit" element={forAdmins(<WorkspaceAuditPage />)} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:key/*" element={<ProjectPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:handle" element={<AgentPage />} />
        <Route path="webhooks" element={forAdmins(<WebhooksPage />)} />
        <Route path="rules" element={forAdmins(<RulesPage />)} />
        <Route path="integrations" element={forAdmins(<IntegrationsPage />)} />
        <Route path="secrets" element={forAdmins(<SecretsPage />)} />
        <Route path="sources" element={forAdmins(<SourcesPage />)} />
        <Route path="me" element={<Navigate to="profile" replace />} />
        <Route path="me/profile" element={<ProfilePage />} />
        <Route path="me/security" element={<SecurityPage />} />
        <Route path="me/notifications" element={<NotificationsPage />} />
        <Route path="me/tokens" element={<MyTokensPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </NavLayout>
  );
}
