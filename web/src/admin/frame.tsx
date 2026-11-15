// The frame of the admin area. It stands outside any workspace: a slim bar
// on top, the list of pages on the left, and the install's settings loaded
// once for every page.

import { type ReactNode, useMemo } from "react";
import {
  Activity,
  ArrowLeft,
  Building2,
  DatabaseBackup,
  Gauge,
  HardDrive,
  KeyRound,
  Mail,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { Link } from "react-router";
import { useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { usePageTitle } from "@/lib/ui-state";
import { Avatar } from "@/ui/avatar";
import { EmptyState } from "@/ui/empty";
import { QuadMark } from "@/ui/icons";
import { useSettings } from "@/admin/settings";
import { LoadGate } from "@/ui/load-gate";
import { type NavGroup, NavLayout } from "@/ui/page-layout";

function useGroups(): NavGroup[] {
  return useMemo(
    () => [
      {
        title: t("admin.group.install"),
        items: [
          { to: "general", label: t("admin.nav.general"), icon: <SlidersHorizontal /> },
          { to: "sign-in", label: t("admin.nav.signIn"), icon: <KeyRound /> },
          { to: "mail", label: t("admin.nav.mail"), icon: <Mail /> },
          { to: "storage", label: t("admin.nav.storage"), icon: <HardDrive /> },
          { to: "limits", label: t("admin.nav.limits"), icon: <Gauge /> },
          { to: "backups", label: t("admin.nav.backups"), icon: <DatabaseBackup /> },
        ],
      },
      {
        title: t("admin.group.people"),
        items: [
          { to: "users", label: t("admin.nav.users"), icon: <Users /> },
          { to: "workspaces", label: t("admin.nav.workspaces"), icon: <Building2 /> },
        ],
      },
      {
        title: t("admin.group.watch"),
        items: [
          { to: "audit", label: t("admin.nav.audit"), icon: <ScrollText /> },
          { to: "health", label: t("admin.nav.health"), icon: <Activity /> },
        ],
      },
    ],
    [],
  );
}

function TopBar({ installName }: { installName?: string }) {
  const user = useSession((s) => s.user);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line bg-surface px-3 md:px-4">
      <Link to="/admin" className="flex items-center gap-2 rounded-md" aria-label={t("admin.title")}>
        <QuadMark size={20} />
        <span className="text-sm font-semibold">{t("admin.title")}</span>
      </Link>
      {installName && (
        <span className="min-w-0 truncate border-l border-line pl-2.5 text-sm text-ink-2 max-sm:hidden">
          {installName}
        </span>
      )}
      <span className="flex-1" />
      <Link
        to="/"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-ink-2 hover:bg-hover hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("admin.backToWorkspace")}
      </Link>
      {user && (
        <span className="flex items-center gap-2 pl-1" title={user.email}>
          <Avatar member={{ user_id: user.id, name: user.name, kind: user.kind, avatar: user.avatar }} size="md" />
          <span className="max-w-40 truncate text-sm text-ink-2 max-md:hidden">{user.name}</span>
        </span>
      )}
    </header>
  );
}

/** What someone who does not run the install sees at /admin. */
function NotForYou() {
  return (
    <div className="flex h-dvh flex-col bg-surface">
      <TopBar />
      <EmptyState
        icon={<ShieldAlert />}
        title={t("admin.denied.title")}
        hint={t("admin.denied.hint")}
        action={
          <Link to="/" className="text-sm font-medium text-accent-text underline-offset-2 hover:underline">
            {t("admin.backToWorkspace")}
          </Link>
        }
      />
    </div>
  );
}

export function AdminFrame({ children }: { children: ReactNode }) {
  usePageTitle(t("admin.title"));
  const isAdmin = useSession((s) => !!s.user?.is_admin);
  const groups = useGroups();
  const settings = useSettings(isAdmin);

  if (!isAdmin) return <NotForYou />;
  const name = settings.data?.["install.name"]?.value;
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface">
      <TopBar installName={typeof name === "string" && name ? name : "Quadit"} />
      <main className="min-h-0 flex-1">
        <LoadGate of={settings}>
          {() => (
            <NavLayout base="/admin" label={t("admin.title")} groups={groups}>
              {children}
            </NavLayout>
          )}
        </LoadGate>
      </main>
    </div>
  );
}
