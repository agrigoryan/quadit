// One page in the tree: a link with a way to open what is under it, add a
// page inside, and a menu. It can be dragged, and things can be dropped on,
// before or after it.

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronRight, Link2, MoreHorizontal, PenLine, Plus, Smile, Trash2 } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { NavLink } from "react-router";
import { useCan } from "@/lib/access";
import { cx } from "@/lib/cx";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { ui } from "@/lib/ui-state";
import { trashDoc, updateDoc } from "@/docs/actions";
import { docPath, useDocsArea } from "@/docs/area";
import { docTitle, type DocTree } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { marksProject, ProjectMark } from "@/docs/project-mark";
import { IconPicker } from "@/docs/tree/icon-picker";
import { createAndOpen, NewPageItems } from "@/docs/tree/new-page";
import { setOpen, startRename, useTreeState } from "@/docs/tree/state";
import type { Doc } from "@/lib/types-docs";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";

export type DropZone = "before" | "inside" | "after";

export interface DropTarget {
  id: string;
  zone: DropZone;
}

interface Props {
  doc: Doc;
  tree: DocTree;
  depth: number;
  /** Pages of this part of the tree can be moved and changed (by one who may edit the page's project). */
  editable: boolean;
  drop: DropTarget | null;
  /** The project of the page it hangs under (at the top: of the Docs area). Its own is marked when it differs. */
  parentProject: string | undefined;
}

export function TreeNode({ doc, tree, depth, editable: inEditablePart, drop, parentProject }: Props) {
  const slug = useSlug();
  const can = useCan();
  const editable = inEditablePart && can.edit(doc.project_id);
  const { base } = useDocsArea();
  const open = useTreeState((s) => !!s.open[doc.id]);
  const renaming = useTreeState((s) => s.renaming === doc.id);
  const [iconOpen, setIconOpen] = useState(false);
  const kids = tree.children[doc.id] ?? [];
  const drag = useDraggable({ id: doc.id, disabled: !editable || renaming });
  const dropRef = useDroppable({ id: doc.id, disabled: !editable });
  const zone = drop?.id === doc.id ? drop.zone : null;
  const canChange = editable && !doc.generated;
  const marked = marksProject(doc, parentProject);
  const title = docTitle(doc);

  return (
    <li>
      <div
        ref={(el) => {
          drag.setNodeRef(el);
          dropRef.setNodeRef(el);
        }}
        {...drag.listeners}
        className={cx(
          "group relative flex h-7 items-center rounded-md pr-1 text-sm text-ink-2 hover:bg-press/60 has-[a[aria-current]]:bg-press has-[a[aria-current]]:text-ink",
          zone === "inside" && "bg-accent-soft ring-1 ring-accent",
          drag.isDragging && "opacity-40",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {zone && zone !== "inside" && (
          <span
            className={cx(
              "pointer-events-none absolute right-1 h-0.5 rounded bg-accent",
              zone === "before" ? "-top-px" : "-bottom-px",
            )}
            style={{ left: 8 + depth * 14 }}
          />
        )}
        <button
          type="button"
          aria-expanded={kids.length ? open : undefined}
          aria-label={t(open ? "docs.tree.collapse" : "docs.tree.expand", { title })}
          onClick={() => setOpen(doc.id, !open)}
          className={cx(
            "flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-press hover:text-ink",
            kids.length === 0 && "invisible",
          )}
        >
          <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        {canChange ? (
          <IconPicker docId={doc.id} current={doc.icon} open={iconOpen} onOpenChange={setIconOpen}>
            <button
              type="button"
              aria-label={t("docs.icon.changeOf", { title })}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-press"
            >
              <PageIcon doc={doc} />
            </button>
          </IconPicker>
        ) : (
          <span className="flex size-5 shrink-0 items-center justify-center">
            <PageIcon doc={doc} />
          </span>
        )}
        {renaming ? (
          <RenameBox doc={doc} />
        ) : (
          <NavLink
            to={`${base}/${doc.id}`}
            data-tree-row={doc.id}
            draggable={false}
            onClick={() => ui.setDrawer(false)}
            onKeyDown={onRowKey}
            className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 py-1 outline-none focus-visible:underline aria-[current]:font-medium"
          >
            <span className="truncate">{title}</span>
            {marked && <ProjectMark projectId={doc.project_id} />}
          </NavLink>
        )}
        {canChange && !renaming && (
          <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
            <Menu>
              <MenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("docs.tree.more", { title })}
                  className="flex size-5 items-center justify-center rounded-sm text-ink-3 hover:bg-press hover:text-ink"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<PenLine />} onSelect={() => setTimeout(() => startRename(doc.id), 0)}>
                  {t("docs.tree.rename")}
                </MenuItem>
                <MenuItem icon={<Smile />} onSelect={() => setTimeout(() => setIconOpen(true), 0)}>
                  {t("docs.icon.change")}
                </MenuItem>
                <MenuItem
                  icon={<Link2 />}
                  onSelect={() =>
                    void copyText(location.origin + docPath(slug, doc.id)).then((ok) =>
                      toast.info(t(ok ? "common.copied" : "common.copyFailed")),
                    )
                  }
                >
                  {t("docs.copyLink")}
                </MenuItem>
                {doc.kind !== "database" && (
                  <>
                    <MenuSeparator />
                    <NewPageItems parentId={doc.id} />
                  </>
                )}
                <MenuSeparator />
                <MenuItem icon={<Trash2 />} danger onSelect={() => trashDoc(doc.id)}>
                  {t("docs.delete")}
                </MenuItem>
              </MenuContent>
            </Menu>
            {doc.kind !== "database" && (
              <button
                type="button"
                aria-label={t("docs.tree.subpage", { title })}
                title={t("docs.new.subpage")}
                onClick={() => createAndOpen({ parentId: doc.id })}
                className="flex size-5 items-center justify-center rounded-sm text-ink-3 hover:bg-press hover:text-ink"
              >
                <Plus className="size-3.5" />
              </button>
            )}
          </span>
        )}
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((kid) => (
            <TreeNode
              key={kid.id}
              doc={kid}
              tree={tree}
              depth={depth + 1}
              editable={inEditablePart}
              drop={drop}
              parentProject={doc.project_id}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** On a page's link, the arrows walk the tree's pages; right and left open and close a page. */
function onRowKey(e: KeyboardEvent<HTMLAnchorElement>) {
  const tree = e.currentTarget.closest("nav");
  if (!tree) return;
  const rows = [...tree.querySelectorAll<HTMLElement>("[data-tree-row]")];
  const at = rows.indexOf(e.currentTarget);
  const id = e.currentTarget.dataset.treeRow;
  if (at < 0 || !id) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  } else if (e.key === "ArrowRight") setOpen(id, true);
  else if (e.key === "ArrowLeft") setOpen(id, false);
}

function RenameBox({ doc }: { doc: Doc }) {
  const [value, setValue] = useState(doc.title);
  const done = (save: boolean) => {
    if (save) updateDoc(doc.id, { title: value.trim() });
    startRename(null);
  };
  return (
    <input
      autoFocus
      value={value}
      aria-label={t("docs.tree.rename")}
      placeholder={t("docs.untitled")}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => done(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
      className="ml-1 h-6 min-w-0 flex-1 rounded-sm border border-accent bg-surface px-1 text-sm text-ink outline-none"
    />
  );
}
