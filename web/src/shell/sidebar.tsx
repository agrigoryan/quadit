import { Bookmark, Bot, ChartGantt, FileText, Inbox, Layers, LayoutDashboard, ListTodo, MessageCircleQuestion, PanelLeft, RefreshCw, Settings, SquareKanban, Trash2, UserRound } from "lucide-react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { SidebarDocs } from "@/docs/tree/sidebar-docs";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useProjects, useSlug, useUnreadCount, useViews } from "@/lib/selectors";
import type { Project } from "@/lib/types";
import { ui, useUi } from "@/lib/ui-state";
import { NavItem, NavSection } from "@/shell/nav-item";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { IconButton } from "@/ui/button";

function ProjectNav({ project, slug, collapsed }: { project: Project; slug: string; collapsed: boolean }) {
  const base = `/${slug}/p/${project.key}`;
  if (collapsed) {
    return <NavItem to={`${base}/tasks`} label={project.name} collapsed icon={<ProjectGlyph project={project} />} />;
  }
  return (
    <div className="mb-1.5">
      <div className="flex h-7 items-center gap-2 px-2 text-sm font-medium text-ink">
        <ProjectGlyph project={project} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
      </div>
      <div className="flex flex-col gap-px">
        <NavItem nested to={`${base}/tasks`} label={t("nav.tasks")} icon={<ListTodo />} />
        <NavItem nested to={`${base}/board`} label={t("nav.board")} icon={<SquareKanban />} />
        <NavItem nested to={`${base}/timeline`} label={t("nav.timeline")} icon={<ChartGantt />} />
        <NavItem nested to={`${base}/epics`} label={t("nav.epics")} icon={<Layers />} />
        {project.settings?.cycles && <NavItem nested to={`${base}/cycles`} label={t("nav.cycles")} icon={<RefreshCw />} />}
      </div>
    </div>
  );
}

/** A project's key in a small square: its mark wherever the project is named. */
export function ProjectGlyph({ project }: { project: Pick<Project, "key" | "color"> }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-xs text-[8px] leading-none font-bold text-white"
      style={{ background: project.color || "var(--ink-2)" }}
      aria-hidden
    >
      {project.key.slice(0, 2)}
    </span>
  );
}

function SidebarBody({ collapsed }: { collapsed: boolean }) {
  const slug = useSlug();
  const projects = useProjects();
  const views = useViews();
  const unread = useUnreadCount();
  const at = (path: string) => `/${slug}/${path}`;

  return (
    <nav aria-label={t("nav.main")} className="flex h-full flex-col">
      <div className={cx("flex h-11 shrink-0 items-center gap-1", collapsed ? "justify-center" : "pr-1.5 pl-2")}>
        {!collapsed && <WorkspaceSwitcher />}
        <IconButton
          label={collapsed ? t("nav.expand") : t("nav.collapse")}
          onClick={ui.toggleSidebar}
          className="max-md:hidden"
        >
          <PanelLeft className="size-4" />
        </IconButton>
      </div>

      <div className={"min-h-0 flex-1 overflow-y-auto px-2 pb-3"}>
        <div className={cx("flex flex-col gap-px", collapsed && "items-center")}>
          <NavItem to={at("inbox")} label={t("nav.inbox")} icon={<Inbox />} count={unread} loud collapsed={collapsed} />
          <NavItem to={at("my-work")} label={t("nav.myWork")} icon={<UserRound />} collapsed={collapsed} />
        </div>

        <NavSection title={t("nav.projects")} collapsed={collapsed}>
          {projects.map((p) => (
            <ProjectNav key={p.id} project={p} slug={slug} collapsed={collapsed} />
          ))}
        </NavSection>

        {views.length > 0 && (
          <NavSection title={t("nav.views")} collapsed={collapsed}>
            {views.map((v) => (
              <NavItem key={v.id} to={at(`view/${v.slug}`)} label={v.name} icon={<Bookmark />} collapsed={collapsed} />
            ))}
          </NavSection>
        )}

        <SidebarDocs collapsed={collapsed} />

        <NavSection title={t("common.more")} collapsed={collapsed}>
          <NavItem to={at("docs")} label={t("nav.docs")} icon={<FileText />} collapsed={collapsed} />
          <NavItem to={at("dashboard")} label={t("nav.dashboard")} icon={<LayoutDashboard />} collapsed={collapsed} />
          <NavItem to={at("agents")} label={t("nav.agents")} icon={<Bot />} collapsed={collapsed} />
          <NavItem to={at("decisions")} label={t("nav.decisions")} icon={<MessageCircleQuestion />} collapsed={collapsed} />
        </NavSection>
      </div>

      <div className={cx("flex shrink-0 flex-col gap-px border-t border-line p-2", collapsed && "items-center")}>
        <NavItem to={at("trash")} label={t("nav.trash")} icon={<Trash2 />} collapsed={collapsed} />
        <NavItem to={at("settings")} label={t("nav.settings")} icon={<Settings />} collapsed={collapsed} />
      </div>
    </nav>
  );
}

/** The left rail on a desktop; a drawer that slides in on a phone. */
export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const drawerOpen = useUi((s) => s.drawerOpen);
  return (
    <>
      <aside
        className={cx(
          "shrink-0 border-r border-line bg-sunken transition-[width] duration-150 max-md:hidden",
          collapsed ? "w-12" : "w-58",
        )}
      >
        <SidebarBody collapsed={collapsed} />
      </aside>

      <RDialog.Root open={drawerOpen} onOpenChange={ui.setDrawer}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade md:hidden" />
          <RDialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 w-[min(18rem,86vw)] bg-sunken shadow-pop outline-none animate-drawer md:hidden"
          >
            <VisuallyHidden.Root>
              <RDialog.Title>{t("nav.main")}</RDialog.Title>
            </VisuallyHidden.Root>
            <SidebarBody collapsed={false} />
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
    </>
  );
}
