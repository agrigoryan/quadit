import { useId } from "react";
import { Bookmark, PanelLeft } from "lucide-react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { SidebarDocs } from "@/docs/tree/sidebar-docs";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useProjects, useSlug, useUnreadCount, useViews } from "@/lib/selectors";
import type { Project } from "@/lib/types";
import { ui, useUi } from "@/lib/ui-state";
import { type DestinationGroup, destinationPath, goKeys, placesIn } from "@/shell/destinations";
import { NavItem, NavSection } from "@/ui/nav-item";
import { WorkspaceSwitcher } from "@/shell/workspace-switcher";
import { IconButton } from "@/ui/button";
import { ProjectGlyph } from "@/ui/project-glyph";

// What the sidebar lists is the table in shell/destinations.tsx; this file only lays it out.

/** A project's pages: the places every project has, for this one. Folded, the project is one mark that opens its first page. */
function ProjectNav({ project, slug, collapsed }: { project: Project; slug: string; collapsed: boolean }) {
  const nameId = useId();
  const pages = placesIn("project").flatMap((place) => {
    const to = destinationPath(place, { slug, project, installAdmin: false });
    return to ? [{ place, to }] : [];
  });
  if (collapsed) {
    const first = pages[0];
    return first ? (
      <NavItem to={first.to} label={project.name} collapsed icon={<ProjectGlyph project={project} />} />
    ) : null;
  }
  return (
    <div className="mb-1.5">
      <div className="flex h-7 items-center gap-2 px-2 text-sm font-medium text-ink">
        <ProjectGlyph project={project} />
        <span id={nameId} className="min-w-0 flex-1 truncate">
          {project.name}
        </span>
      </div>
      {/* Every project has a "Tasks" and a "Board": the list's name says whose they are. */}
      <ul aria-labelledby={nameId} className="flex flex-col gap-px">
        {pages.map(({ place, to }) => (
          <li key={place.id}>
            <NavItem nested to={to} label={t(place.label)} icon={place.icon} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The places of one part of the sidebar. Folded to icons, each says its keys in its tooltip. */
function Places({ group, slug, collapsed }: { group: DestinationGroup; slug: string; collapsed: boolean }) {
  const unread = useUnreadCount();
  return (
    <>
      {placesIn(group).map((place) => {
        const to = destinationPath(place, { slug, project: undefined, installAdmin: false });
        if (!to) return null;
        return (
          <NavItem
            key={place.id}
            to={to}
            label={t(place.label)}
            icon={place.icon}
            hint={goKeys(place)}
            count={place.count === "unread" ? unread : undefined}
            loud={!!place.count}
            collapsed={collapsed}
          />
        );
      })}
    </>
  );
}

function SidebarBody({ collapsed }: { collapsed: boolean }) {
  const slug = useSlug();
  const projects = useProjects();
  const views = useViews();

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
          <Places group="top" slug={slug} collapsed={collapsed} />
        </div>

        <NavSection title={t("nav.projects")} collapsed={collapsed}>
          {projects.map((p) => (
            <ProjectNav key={p.id} project={p} slug={slug} collapsed={collapsed} />
          ))}
        </NavSection>

        {views.length > 0 && (
          <NavSection title={t("nav.views")} collapsed={collapsed}>
            {views.map((v) => (
              <NavItem
                key={v.id}
                to={`/${slug}/view/${v.slug}`}
                label={v.name}
                icon={<Bookmark />}
                collapsed={collapsed}
              />
            ))}
          </NavSection>
        )}

        <SidebarDocs collapsed={collapsed} />

        <NavSection title={t("common.more")} collapsed={collapsed}>
          <Places group="more" slug={slug} collapsed={collapsed} />
        </NavSection>
      </div>

      <div className={cx("flex shrink-0 flex-col gap-px border-t border-line p-2", collapsed && "items-center")}>
        <Places group="foot" slug={slug} collapsed={collapsed} />
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
