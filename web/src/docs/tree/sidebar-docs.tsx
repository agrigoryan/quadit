// The docs part of the main sidebar: the top of the page tree, compact.
// The full tree, with drag and drop and the trash, is in the Docs area.

import { ChevronRight, Plus } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useSlug } from "@/lib/selectors";
import { ui } from "@/lib/ui-state";
import { createDoc } from "@/docs/actions";
import { docTitle, type DocTree, useDocTree } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { marksProject, ProjectMark } from "@/docs/project-mark";
import { setOpen, useTreeState } from "@/docs/tree/state";
import type { Doc } from "@/docs/types";
import { NavSection } from "@/shell/nav-item";

const MAX_DEPTH = 3;

interface RowProps {
  doc: Doc;
  tree: DocTree;
  depth: number;
  slug: string;
  /** The project of the page it hangs under; its own is marked when it differs. */
  parentProject: string | undefined;
}

function Row({ doc, tree, depth, slug, parentProject }: RowProps) {
  const open = useTreeState((s) => !!s.open[doc.id]);
  const kids = depth < MAX_DEPTH ? (tree.children[doc.id] ?? []) : [];
  return (
    <>
      <div
        className="group flex h-7 items-center rounded-md text-sm text-ink-2 hover:bg-press/60 hover:text-ink has-[a[aria-current]]:bg-press has-[a[aria-current]]:font-medium has-[a[aria-current]]:text-ink"
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={t(open ? "docs.tree.collapse" : "docs.tree.expand")}
          onClick={() => setOpen(doc.id, !open)}
          className={cx("flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-press", kids.length === 0 && "invisible")}
        >
          <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <NavLink to={`/${slug}/docs/${doc.id}`} onClick={() => ui.setDrawer(false)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2">
          <PageIcon doc={doc} />
          <span className="truncate">{docTitle(doc)}</span>
          {marksProject(doc, parentProject) && <ProjectMark projectId={doc.project_id} />}
        </NavLink>
      </div>
      {open && kids.map((kid) => <Row key={kid.id} doc={kid} tree={tree} depth={depth + 1} slug={slug} parentProject={doc.project_id} />)}
    </>
  );
}

/** A section of the main sidebar listing the team's pages and the person's own. Shows nothing when the sidebar is folded. */
export function SidebarDocs({ collapsed }: { collapsed: boolean }) {
  const slug = useSlug();
  const me = useMe();
  const tree = useDocTree();
  const navigate = useNavigate();
  if (collapsed) return null;
  const roots = [...tree.roots.team, ...tree.roots.private.filter((d) => d.owner_id === me.user_id)];
  return (
    <NavSection title={t("nav.docs")}>
      <div className="relative">
        <button
          type="button"
          aria-label={t("docs.new.blank")}
          title={t("docs.new.blank")}
          onClick={() => {
            ui.setDrawer(false);
            void navigate(`/${slug}/docs/${createDoc()}`);
          }}
          className="absolute -top-6 right-1 flex size-5 items-center justify-center rounded-sm text-ink-3 hover:bg-press hover:text-ink"
        >
          <Plus className="size-3.5" />
        </button>
        {roots.length === 0 && <p className="px-2 py-1 text-xs text-ink-3">{t("docs.section.teamEmpty")}</p>}
        {roots.slice(0, 12).map((doc) => (
          <Row key={doc.id} doc={doc} tree={tree} depth={0} slug={slug} parentProject={undefined} />
        ))}
        {roots.length > 12 && (
          <NavLink to={`/${slug}/docs`} onClick={() => ui.setDrawer(false)} className="flex h-7 items-center rounded-md px-2 pl-7 text-sm text-ink-3 hover:bg-press/60 hover:text-ink">
            {t("docs.tree.all", { n: roots.length })}
          </NavLink>
        )}
      </div>
    </NavSection>
  );
}
