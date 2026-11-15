// The page tree of the Docs area: the team's pages, the person's private
// ones, each agent's memory, and the pages built from data. Pages are
// dragged to reorder them or to put one inside another. In a project's
// Docs it is the same tree, of that project's pages.

import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { rankBetween } from "@/lib/rank";
import { useCollection, useMe } from "@/lib/selectors";
import { lastRank, moveDoc } from "@/docs/actions";
import { useDocsArea } from "@/docs/area";
import { docTitle, type DocTree, getDocs, isWithin, sectionOf } from "@/docs/data";
import { PageIcon } from "@/docs/page-icon";
import { NewPageItems } from "@/docs/tree/new-page";
import { setOpen } from "@/docs/tree/state";
import { type DropTarget, type DropZone, TreeNode } from "@/docs/tree/tree-node";
import { TrashButton } from "@/docs/tree/trash-button";
import type { Doc } from "@/docs/types";
import { Menu, MenuContent, MenuTrigger } from "@/ui/menu";

/** Where a dragged page would land, if it may land there. */
function targetOf(event: DragMoveEvent): DropTarget | null {
  const over = event.over;
  const docs = getDocs();
  const moving = docs[String(event.active.id)];
  const onto = over ? docs[String(over.id)] : undefined;
  const start = event.activatorEvent as PointerEvent;
  if (!over || !moving || !onto || moving.id === onto.id) return null;
  // A page cannot go inside itself, and stays among pages of its own kind (team or private).
  if (isWithin(docs, onto.id, moving.id) || sectionOf(moving) !== sectionOf(onto)) return null;
  const y = start.clientY + event.delta.y - over.rect.top;
  let zone: DropZone = y < over.rect.height * 0.28 ? "before" : y > over.rect.height * 0.72 ? "after" : "inside";
  if (zone === "inside" && onto.kind === "database") zone = "after";
  return { id: onto.id, zone };
}

function drop(tree: DocTree, movingId: string, target: DropTarget) {
  const docs = getDocs();
  const onto = docs[target.id];
  if (!onto) return;
  if (target.zone === "inside") {
    moveDoc(movingId, onto.id, lastRank(onto.id));
    setOpen(onto.id, true);
    return;
  }
  const parent =
    onto.parent_id && docs[onto.parent_id] && sectionOf(docs[onto.parent_id] as Doc) === sectionOf(onto)
      ? onto.parent_id
      : undefined;
  const list = (parent ? (tree.children[parent] ?? []) : tree.roots[sectionOf(onto)]).filter((d) => d.id !== movingId);
  const at = list.findIndex((d) => d.id === onto.id);
  const rank =
    target.zone === "before" ? rankBetween(list[at - 1]?.rank, onto.rank) : rankBetween(onto.rank, list[at + 1]?.rank);
  moveDoc(movingId, onto.parent_id ?? null, rank);
}

/** Arrow keys walk the tree's rows; right and left open and close a page. */
function onTreeKey(e: KeyboardEvent<HTMLElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const id = (rows[at] as HTMLElement).dataset.treeRow as string;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  } else if (e.key === "ArrowRight") setOpen(id, true);
  else if (e.key === "ArrowLeft") setOpen(id, false);
}

interface Props {
  /** The pages to show: the area's own tree (docs/data.ts useDocTree). */
  tree: DocTree;
  className?: string;
}

export function DocsTree({ tree, className }: Props) {
  const projectId = useDocsArea().project?.id;
  const me = useMe();
  const members = useCollection("members");
  const [dragging, setDragging] = useState<Doc | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const end = (event: DragEndEvent) => {
    const to = targetOf(event);
    if (to) drop(tree, String(event.active.id), to);
    setDragging(null);
    setTarget(null);
  };

  const nodes = (list: Doc[], editable: boolean) =>
    list.map((doc) => (
      <TreeNode
        key={doc.id}
        doc={doc}
        tree={tree}
        depth={0}
        editable={editable}
        drop={target}
        parentProject={projectId}
      />
    ));

  // An agent's notes hang under one page per agent; group them by whose they are.
  const byAgent = new Map<string, Doc[]>();
  for (const doc of tree.roots.memory)
    byAgent.set(doc.memory_of as string, [...(byAgent.get(doc.memory_of as string) ?? []), doc]);

  return (
    <nav aria-label={t("docs.tree.label")} className={cx("flex min-h-0 flex-col", className)} onKeyDown={onTreeKey}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setDragging(getDocs()[String(e.active.id)] ?? null)}
        onDragMove={(e) => setTarget(targetOf(e))}
        onDragEnd={end}
        onDragCancel={() => {
          setDragging(null);
          setTarget(null);
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <TreeSection
            title={t("docs.section.team")}
            add={<NewPageItems generated projectId={projectId} />}
            empty={t("docs.section.teamEmpty")}
          >
            {nodes(tree.roots.team, true)}
          </TreeSection>
          <TreeSection
            title={t("docs.section.private")}
            add={<NewPageItems private projectId={projectId} />}
            empty={t("docs.section.privateEmpty")}
          >
            {nodes(
              tree.roots.private.filter((d) => d.owner_id === me.user_id),
              true,
            )}
          </TreeSection>
          {tree.roots.private.some((d) => d.owner_id !== me.user_id) && (
            <TreeSection title={t("docs.section.shared")}>
              {nodes(
                tree.roots.private.filter((d) => d.owner_id !== me.user_id),
                false,
              )}
            </TreeSection>
          )}
          {[...byAgent].map(([agentId, docs]) => (
            <TreeSection
              key={agentId}
              title={t("docs.section.memory", { name: members[agentId]?.name ?? t("common.agent") })}
            >
              {nodes(docs, false)}
            </TreeSection>
          ))}
          {tree.roots.generated.length > 0 && (
            <TreeSection title={t("docs.section.generated")}>{nodes(tree.roots.generated, false)}</TreeSection>
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="flex h-7 w-52 items-center gap-1.5 rounded-md bg-surface px-2 text-sm text-ink shadow-pop">
              <PageIcon doc={dragging} />
              <span className="truncate">{docTitle(dragging)}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <div className="shrink-0 border-t border-line p-2">
        <TrashButton projectId={projectId} />
      </div>
    </nav>
  );
}

function TreeSection({
  title,
  add,
  empty,
  children,
}: {
  title: string;
  add?: ReactNode;
  empty?: string;
  children: ReactNode[];
}) {
  return (
    <section className="mt-3 first:mt-1">
      <div className="mb-0.5 flex h-6 items-center justify-between pr-1 pl-2">
        <h2 className="text-xs font-medium text-ink-3">{title}</h2>
        {add && (
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={t("docs.new.inSection", { section: title })}
                className="flex size-5 items-center justify-center rounded-sm text-ink-3 hover:bg-press hover:text-ink"
              >
                <Plus className="size-3.5" />
              </button>
            </MenuTrigger>
            <MenuContent align="start">{add}</MenuContent>
          </Menu>
        )}
      </div>
      {children.length > 0 ? (
        <ul role="tree" aria-label={title}>
          {children}
        </ul>
      ) : (
        empty && <p className="px-2 py-1 text-xs text-ink-3">{empty}</p>
      )}
    </section>
  );
}
