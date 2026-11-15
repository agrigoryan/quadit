// A status edited from its own column on the board: rename it, give it a
// colour, say what kind of status it is, move it left or right, delete it.
// Only admins see this (the server lets nobody else change statuses).

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  MoreHorizontal,
  Palette,
  Pencil,
  Shapes,
  Trash2,
} from "lucide-react";
import { DropdownMenu as RMenu } from "radix-ui";
import { ApiError, errorMessage } from "@/lib/api";
import { t, tMaybe } from "@/lib/i18n";
import { mutate, send } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { useStatuses } from "@/lib/selectors";
import { CATEGORIES, type Category, type Project, type Status } from "@/lib/types";
import { SWATCHES } from "@/lib/swatches";
import { Button, IconButton } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { StatusIcon } from "@/ui/icons";
import { Field } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { Select } from "@/ui/picker";

const patch = (status: Status, fields: Partial<Status>) =>
  send({ type: "status.update", args: { id: status.id, ...fields } }, (tx) => tx.patch("statuses", status.id, fields));

export const renameStatus = (status: Status, name: string) => patch(status, { name });

const subTrigger =
  "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm text-ink outline-none select-none " +
  "data-[highlighted]:bg-hover data-[state=open]:bg-hover [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-2";
const subContent = "z-[60] rounded-lg bg-surface p-1 text-ink shadow-pop outline-none animate-pop";

interface Props {
  status: Status;
  project: Project;
  /** Turns the column's name into a box to retype it. */
  onRename: () => void;
}

export function StatusMenu({ status, project, onRename }: Props) {
  const statuses = useStatuses(project.id);
  const [deleting, setDeleting] = useState(false);
  const at = statuses.findIndex((s) => s.id === status.id);

  /** One place left or right: a rank between the two statuses it lands between. */
  function move(step: -1 | 1) {
    const before = step < 0 ? statuses[at - 2] : statuses[at + 1];
    const after = step < 0 ? statuses[at - 1] : statuses[at + 2];
    patch(status, { rank: rankBetween(before?.rank, after?.rank) });
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="sm" label={t("col.menu", { name: status.name })}>
            <MoreHorizontal className="size-3.5" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Pencil />} onSelect={onRename}>
            {t("col.rename")}
          </MenuItem>
          <RMenu.Sub>
            <RMenu.SubTrigger className={subTrigger}>
              <Palette />
              <span className="flex-1">{t("col.color")}</span>
              <ChevronRight />
            </RMenu.SubTrigger>
            <RMenu.Portal>
              <RMenu.SubContent
                sideOffset={4}
                collisionPadding={8}
                aria-label={t("col.color")}
                className={`${subContent} grid grid-cols-6 gap-0.5`}
              >
                {SWATCHES.map((color) => (
                  <RMenu.Item
                    key={color}
                    aria-label={tMaybe(`swatch.${color}`, color)}
                    title={tMaybe(`swatch.${color}`, color)}
                    onSelect={() => patch(status, { color })}
                    className="flex size-7 cursor-default items-center justify-center rounded-sm outline-none data-[highlighted]:bg-hover"
                  >
                    <span
                      className="flex size-4 items-center justify-center rounded-full text-white"
                      style={{ background: color }}
                    >
                      {status.color?.toLowerCase() === color && (
                        <Check className="size-3" strokeWidth={3} aria-hidden />
                      )}
                    </span>
                  </RMenu.Item>
                ))}
              </RMenu.SubContent>
            </RMenu.Portal>
          </RMenu.Sub>
          <RMenu.Sub>
            <RMenu.SubTrigger className={subTrigger}>
              <Shapes />
              <span className="flex-1">{t("col.category")}</span>
              <span className="text-xs text-ink-3">{t(`category.${status.category}`)}</span>
              <ChevronRight />
            </RMenu.SubTrigger>
            <RMenu.Portal>
              <RMenu.SubContent sideOffset={4} collisionPadding={8} className={`${subContent} min-w-40`}>
                <MenuRadioGroup
                  value={status.category}
                  onValueChange={(category) => patch(status, { category: category as Category })}
                >
                  {CATEGORIES.map((category) => (
                    <MenuRadioItem key={category} value={category}>
                      <span className="flex items-center gap-2">
                        <StatusIcon category={category} />
                        {t(`category.${category}`)}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </RMenu.SubContent>
            </RMenu.Portal>
          </RMenu.Sub>
          <MenuSeparator />
          <MenuItem icon={<ArrowLeft />} disabled={at <= 0} onSelect={() => move(-1)}>
            {t("col.moveLeft")}
          </MenuItem>
          <MenuItem icon={<ArrowRight />} disabled={at < 0 || at >= statuses.length - 1} onSelect={() => move(1)}>
            {t("col.moveRight")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 />} onSelect={() => setDeleting(true)}>
            {t("col.delete")}
          </MenuItem>
        </MenuContent>
      </Menu>
      {deleting && (
        <DeleteStatus
          status={status}
          others={statuses.filter((s) => s.id !== status.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

/**
 * Asks before deleting. The server refuses while tasks have the status; its
 * reason is shown as it came, with a place to say where those tasks go.
 */
function DeleteStatus({ status, others, onClose }: { status: Status; others: Status[]; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const [needsMove, setNeedsMove] = useState(false);
  const [moveTo, setMoveTo] = useState(
    () => (others.find((s) => s.category === status.category) ?? others[0])?.id ?? "",
  );

  async function confirm() {
    setBusy(true);
    try {
      await mutate(
        { type: "status.delete", args: { id: status.id, ...(needsMove && moveTo ? { move_to: moveTo } : {}) } },
        undefined,
        { quiet: true },
      );
      onClose();
    } catch (err) {
      setRefusal(errorMessage(err));
      if (err instanceof ApiError && err.field === "move_to") setNeedsMove(true);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("col.delete.title", { name: status.name })}
      description={t("col.delete.body")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={busy || (needsMove && !moveTo)} onClick={() => void confirm()}>
            {needsMove ? t("col.delete.move") : t("col.delete")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {refusal && (
          <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-1.5 text-sm text-danger">
            {refusal}
          </p>
        )}
        {needsMove && (
          <Field label={t("col.delete.moveTo")}>
            <Select
              label={t("col.delete.moveTo")}
              value={moveTo}
              items={others.map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon category={s.category} /> }))}
              onPick={setMoveTo}
              buttonProps={{ className: "h-8 w-full justify-between!" }}
            />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
