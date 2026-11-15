// A task's status type: the kind of status it is in (to do, in progress,
// done…), the same across projects whose statuses differ. Read from the
// status; set only by setting that.

import { useMemo } from "react";
import { t, tMaybe } from "@/lib/i18n";
import { CATEGORIES, type Category } from "@/types/core";
import type { TaskProperty } from "@/tasks/properties/property";
import { rowsNamed } from "@/tasks/properties/query-words";
import { StatusIcon } from "@/ui/icons";

const isCategory = (word: string): word is Category => (CATEGORIES as string[]).includes(word);

export const category = {
  name: "category",
  title: () => t("filter.category"),
  filter: {
    word: "category",
    title: () => t("filter.category"),
    useOptions: () =>
      useMemo(
        () =>
          CATEGORIES.map((cat) => ({ id: cat, label: tMaybe(`category.${cat}`), icon: <StatusIcon category={cat} /> })),
        [],
      ),
    matches: (task, picked, c) => picked.includes(c.statuses[task.status_id]?.category ?? ""),
    // A status word that names no status but a status type ("waiting") is read as the type.
    read: (q, ctx) =>
      [
        ...(q.category ?? []),
        ...(q.status ?? [])
          .filter((ref) => rowsNamed(ctx.c.statuses, ref, ctx).length === 0)
          .map((ref) => ref.toLowerCase()),
      ].filter(isCategory),
  },
} satisfies TaskProperty<"category">;
