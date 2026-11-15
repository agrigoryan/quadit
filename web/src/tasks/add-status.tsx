// The last column of a project's board, for admins: a new status, made
// where it will be used.

import { type FormEvent, useState } from "react";
import { Plus } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { rankBetween } from "@/lib/rank";
import { statusesOf } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { CATEGORIES, type Category, type Project } from "@/lib/types";
import { Button } from "@/ui/button";
import { StatusIcon } from "@/ui/icons";
import { Input } from "@/ui/input";
import { Select } from "@/ui/picker";

/** The colour a new status starts with, by what kind it is. It can be changed from the column's menu. */
const START_COLOR: Record<Category, string> = {
  backlog: "#6b7183",
  unstarted: "#6b7183",
  started: "#3451e0",
  waiting: "#c26a00",
  done: "#16874a",
  canceled: "#6b7183",
};

/** Creates a status at the end of the project's list. Rejects with the server's reason if it is refused. */
export function createStatus(project: Project, name: string, category: Category): Promise<unknown> {
  const id = newId();
  const last = statusesOf(getState().c.statuses, project.id).at(-1)?.rank;
  const row = { name, category, color: START_COLOR[category], rank: rankBetween(last, undefined) };
  return mutate({ type: "status.create", args: { id, project: project.id, ...row } }, (tx) => tx.insert("statuses", { id, project_id: project.id, ...row }), {
    quiet: true,
  });
}

export function AddStatusColumn({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("started");
  const [error, setError] = useState("");

  function close() {
    setOpen(false);
    setName("");
    setError("");
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = name.trim();
    if (!text) return setError(t("col.add.needName"));
    try {
      await createStatus(project, text, category);
      close();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!open) {
    return (
      <section aria-label={t("col.add")} className="w-72 shrink-0 max-sm:w-[82vw]">
        <Button variant="ghost" className="h-9 w-full justify-start border border-dashed border-line-strong" onClick={() => setOpen(true)}>
          <Plus className="size-3.5" aria-hidden />
          {t("col.add")}
        </Button>
      </section>
    );
  }

  return (
    <section aria-label={t("col.add")} className="w-72 shrink-0 rounded-lg bg-sunken p-2 max-sm:w-[82vw]">
      <form
        onSubmit={(e) => void add(e)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
        className="flex flex-col gap-2"
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("col.add.name")}
          aria-label={t("col.add.name")}
          aria-invalid={!!error}
        />
        <Select
          label={t("col.category")}
          value={category}
          items={CATEGORIES.map((c) => ({ id: c, label: t(`category.${c}`), icon: <StatusIcon category={c} /> }))}
          onPick={(id) => setCategory(id as Category)}
          buttonProps={{ className: "h-8 w-full justify-between!" }}
        />
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("col.add")}
          </Button>
        </div>
      </form>
    </section>
  );
}
