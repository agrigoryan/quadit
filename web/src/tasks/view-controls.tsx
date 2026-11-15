import { type FormEvent, useState } from "react";
import { Bookmark, Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useCan } from "@/lib/access";
import { t } from "@/lib/i18n";
import { mutate, send } from "@/lib/mutate";
import { useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import type { Project, SortBy, View } from "@/lib/types";
import { type Grouping, toQuery } from "@/tasks/filters";
import {
  BOARD_GROUPS,
  type BoardGrouping,
  LIST_GROUPS,
  resetViewState,
  type StoredDisplay,
  SUBTASKS,
  type Subtasks,
  type ViewState,
} from "@/tasks/view-state";
import { Button, IconButton } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { FormField } from "@/ui/form";
import { Input } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { Select } from "@/ui/picker";

const SORTS: SortBy[] = ["manual", "priority", "updated", "created", "due"];

/** How the tasks are grouped and ordered, and the list's sub-tasks shown. A board is always in manual order: its cards are dragged into place. */
export function DisplayControls({
  state,
  onChange,
}: {
  state: ViewState;
  onChange: (patch: Partial<ViewState>) => void;
}) {
  if (state.layout === "board") {
    return (
      <Select
        label={t("group.columns")}
        prefix={t("group.columns")}
        value={state.boardGroup}
        items={BOARD_GROUPS.map((g) => ({ id: g, label: t(`group.${g}`) }))}
        onPick={(id) => onChange({ boardGroup: id as BoardGrouping })}
        align="end"
        buttonProps={{ variant: "ghost", size: "sm" }}
      />
    );
  }
  return (
    <>
      <Select
        label={t("group.by")}
        prefix={t("group.by")}
        value={state.group}
        items={LIST_GROUPS.map((g) => ({ id: g, label: t(`group.${g}`) }))}
        onPick={(id) => onChange({ group: id as Grouping })}
        align="end"
        buttonProps={{ variant: "ghost", size: "sm" }}
      />
      <Select
        label={t("sort.label")}
        prefix={t("sort.label")}
        value={state.sort}
        items={SORTS.map((s) => ({ id: s, label: t(`sort.${s}`) }))}
        onPick={(id) => onChange({ sort: id as SortBy })}
        align="end"
        buttonProps={{ variant: "ghost", size: "sm" }}
      />
      <Select
        label={t("subtasks.label")}
        prefix={t("subtasks.label")}
        value={state.subtasks}
        items={SUBTASKS.map((s) => ({ id: s, label: t(`subtasks.${s}`) }))}
        onPick={(id) => onChange({ subtasks: id as Subtasks })}
        align="end"
        buttonProps={{ variant: "ghost", size: "sm" }}
      />
    </>
  );
}

/** What a view stores of the page's state. */
function viewArgs(state: ViewState, project: Project | undefined) {
  return {
    query: toQuery(state.filters, project?.key, state.sort),
    layout: state.layout,
    display: {
      group: state.group,
      board_group: state.boardGroup,
      sort: state.sort,
      subtasks: state.subtasks,
    } satisfies StoredDisplay,
  };
}

interface NameDialogProps {
  title: string;
  initial: string;
  submit: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

function NameDialog({ title, initial, submit, onSubmit, onClose }: NameDialogProps) {
  const [name, setName] = useState(initial);
  function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim());
    onClose();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title} size="sm">
      <form onSubmit={save} className="flex flex-col gap-3">
        <FormField label={t("view.name")} htmlFor="view-name" hint={t("view.shared")}>
          <Input
            id="view-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("view.namePlaceholder")}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {submit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface Props {
  state: ViewState;
  /** The page's key in view-state, cleared after a save so the page shows what is stored. */
  scope: string;
  project: Project | undefined;
  /** The saved view being shown, if any. */
  view: View | undefined;
  /** Whether the page differs from what the view has saved. */
  changed: boolean;
}

/** Save the page as a view; on a saved view: update, rename, delete. */
export function ViewControls({ state, scope, project, view, changed }: Props) {
  const slug = useSlug();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"save" | "rename" | null>(null);
  const can = useCan();
  /** Saving the page as a new view. */
  const mayCreate = can.write;
  /** Updating, renaming or deleting the view shown: its owner's, or an admin's. */
  const mayChange = !!view && can.editMadeBy(view.owner_id);

  async function create(name: string) {
    try {
      const results = await mutate({
        type: "view.create",
        args: { name, project: project?.id, shared: true, ...viewArgs(state, project) },
      });
      toast.info(t("view.saved"));
      const saved = results[0]?.key;
      if (saved) void navigate(`/${slug}/view/${saved}`);
    } catch {
      // The refusal is already shown.
    }
  }

  function update() {
    if (!view) return;
    const args = viewArgs(state, project);
    send({ type: "view.update", args: { id: view.id, ...args } }, (tx) => tx.patch("views", view.id, args));
    resetViewState(scope);
    toast.info(t("view.updated"));
  }

  function remove() {
    if (!view) return;
    send({ type: "view.delete", args: { id: view.id } }, (tx) =>
      tx.patch("views", view.id, { deleted_at: Date.now() }),
    );
    toast.info(t("view.deleted"));
    void navigate(project ? `/${slug}/p/${project.key}/tasks` : `/${slug}/my-work`);
  }

  return (
    <>
      {view ? (
        <>
          {changed && mayChange && (
            <Button size="sm" variant="secondary" onClick={update}>
              {t("view.update")}
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <IconButton size="sm" label={t("view.menu")} disabled={!mayChange && !mayCreate}>
                <Ellipsis className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Pencil />} disabled={!mayChange} onSelect={() => setDialog("rename")}>
                {t("view.rename")}
              </MenuItem>
              <MenuItem icon={<Bookmark />} disabled={!mayCreate} onSelect={() => setDialog("save")}>
                {t("view.save")}
              </MenuItem>
              <MenuItem icon={<Trash2 />} danger disabled={!mayChange} onSelect={remove}>
                {t("view.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      ) : (
        <Button size="sm" variant="ghost" disabled={!mayCreate} onClick={() => setDialog("save")}>
          <Bookmark className="size-3.5" aria-hidden />
          <span className="max-sm:sr-only">{t("view.save")}</span>
        </Button>
      )}
      {dialog === "save" && (
        <NameDialog
          title={t("view.saveTitle")}
          initial=""
          submit={t("view.save")}
          onSubmit={(name) => void create(name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && view && (
        <NameDialog
          title={t("view.rename")}
          initial={view.name}
          submit={t("common.save")}
          onSubmit={(name) =>
            send({ type: "view.update", args: { id: view.id, name } }, (tx) => tx.patch("views", view.id, { name }))
          }
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
