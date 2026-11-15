// Finding tasks for the palette (palette/palette-search.ts): a task in the
// trash or the archive is never offered.

import { expect, it } from "vitest";
import type { SearchHit, Task } from "@/lib/types";
import { hitsOnLiveTasks, searchTasks } from "@/palette/palette-search";

const task = (n: number, title: string, gone: Partial<Task> = {}) =>
  ({ id: `t${n}`, key: `SVA-${n}`, title, updated_at: n, ...gone }) as Task;

it("finds live tasks by key and title, best first", () => {
  const tasks = [task(1, "Quokka stays"), task(2, "Other"), task(12, "Quokka too")];
  expect(searchTasks(tasks, "sva-1").map((found) => found.key)).toEqual(["SVA-1", "SVA-12"]);
  expect(searchTasks(tasks, "quokka").map((found) => found.key)).toEqual(["SVA-12", "SVA-1"]);
});

it("leaves out a task in the trash or the archive", () => {
  const tasks = [
    task(1, "Quokka stays"),
    task(2, "Quokka trashed", { deleted_at: 5 }),
    task(3, "Quokka archived", { archived_at: 6 }),
  ];
  expect(searchTasks(tasks, "quokka").map((found) => found.key)).toEqual(["SVA-1"]);
});

it("leaves out the server's hits in a task the store has as gone", () => {
  const tasks = { t1: task(1, "Live"), t3: task(3, "Archived", { archived_at: 6 }) };
  const hit = (kind: string, scopeType: string, scopeId: string) =>
    ({
      kind,
      entity_id: `${kind}-${scopeId}`,
      scope_type: scopeType,
      scope_id: scopeId,
      title: "",
      snippet: "",
      url: "",
    }) as SearchHit;
  const hits = [
    hit("task", "task", "t1"),
    hit("comment", "task", "t3"),
    hit("task", "task", "t9"),
    hit("doc", "doc", "t3"),
  ];
  expect(hitsOnLiveTasks(hits, tasks).map((h) => h.entity_id)).toEqual(["task-t1", "task-t9", "doc-t3"]);
});
