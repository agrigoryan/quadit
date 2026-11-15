// @vitest-environment jsdom
// What a task page starts from when it shows a saved view (tasks/saved-view.ts).

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Label, View } from "@/lib/types";
import type { QuerySource } from "@/tasks/properties/property";
import { useSavedView } from "@/tasks/saved-view";

const label = (id: string, name: string) => ({ id, name, project_id: "p", color: "" }) as Label;
const tables = (labels: Label[]): QuerySource => ({
  projects: {},
  members: {},
  statuses: {},
  epics: {},
  cycles: {},
  labels: Object.fromEntries(labels.map((l) => [l.id, l])),
});
const view = (display: object) => ({ id: "v", name: "Bugs", query: { label: ["bug"] }, display }) as View;

describe("useSavedView", () => {
  it("keeps the same saved state while the workspace changes in ways that do not touch it", () => {
    const shown = view({ group: "status" });
    const { result, rerender } = renderHook(({ source }) => useSavedView(shown, source, "me"), {
      initialProps: { source: tables([label("l1", "bug")]) },
    });
    const first = result.current.saved;
    expect(first?.filters.label).toEqual(["l1"]);
    rerender({ source: tables([label("l1", "bug"), label("l2", "art")]) });
    expect(result.current.saved).toBe(first);
  });

  it("reads it again when what it names changes", () => {
    const shown = view({ group: "status" });
    const { result, rerender } = renderHook(({ source }) => useSavedView(shown, source, "me"), {
      initialProps: { source: tables([label("l1", "bug")]) },
    });
    rerender({ source: tables([label("l1", "bug"), label("l3", "bug")]) });
    expect(result.current.saved?.filters.label).toEqual(["l1", "l3"]);
  });

  it("follows the view's stored display", () => {
    const { result, rerender } = renderHook(({ shown }) => useSavedView(shown, tables([]), "me"), {
      initialProps: { shown: view({ group: "status" }) },
    });
    expect(result.current.saved?.group).toBe("status");
    rerender({ shown: view({ group: "assignee" }) });
    expect(result.current.saved?.group).toBe("assignee");
  });
});
