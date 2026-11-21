// The sample tasks (tasks/samples.ts): what is left of them, and asking for
// them waits until the feed has brought them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/data/api";
import { applyEvents, clearStore, type Dict, loadBootstrap } from "@/data/store";
import { addSamples, samplesLeft } from "@/tasks/samples";
import type { FeedEvent, Member, Project, Task, User, Workspace } from "@/types/core";

const event = (seq: number, over: Partial<FeedEvent>): FeedEvent => ({
  seq,
  at: 1000 + seq,
  actor_id: "u1",
  change_id: `c${seq}`,
  type: "task.updated",
  entity_type: "task",
  entity_id: "",
  scope_type: "",
  scope_id: "",
  data: {},
  ...over,
});
const project = { id: "p", key: "GS", name: "Getting started", samples: ["t1", "t2", "t3"] } as Project;
const task = (id: string, key: string, assignee?: string, more: Partial<Task> = {}) =>
  ({ id, key, project_id: "p", assignee_id: assignee, ...more }) as Task;
const members: Dict<Member> = {
  u1: { user_id: "u1", kind: "person", name: "Maya" } as Member,
  cc: { user_id: "cc", kind: "agent", name: "Claude Code" } as Member,
};

describe("what is left of the samples", () => {
  it("names the agent the third is for", () => {
    const tasks = { t1: task("t1", "GS-1", "u1"), t2: task("t2", "GS-2", "u1"), t3: task("t3", "GS-3", "cc") };
    expect(samplesLeft(project, tasks, members)).toEqual({
      tasks: [tasks.t1, tasks.t2, tasks.t3],
      third: tasks.t3,
      forAgent: { key: "GS-3", agent: "Claude Code" },
    });
  });

  it("names no one when the third is a person's, nobody's or gone", () => {
    const one = { t1: task("t1", "GS-1", "u1") };
    expect(samplesLeft(project, { ...one, t3: task("t3", "GS-3", "u1") }, members)?.forAgent).toBeUndefined();
    expect(samplesLeft(project, { ...one, t3: task("t3", "GS-3") }, members)?.forAgent).toBeUndefined();
    expect(samplesLeft(project, one, members)).toEqual({ tasks: [one.t1], third: undefined, forAgent: undefined });
  });

  it("counts an archived sample, and neither one in the trash nor one moved to another project", () => {
    const tasks = {
      t1: task("t1", "GS-1", "u1", { archived_at: 5 }),
      t2: task("t2", "GS-2", "u1", { deleted_at: 6 }),
      t3: task("t3", "SVA-9", "cc", { project_id: "q" }),
    };
    expect(samplesLeft(project, tasks, members)).toEqual({ tasks: [tasks.t1], third: undefined, forAgent: undefined });
  });

  it("is nothing once every sample is in the trash, or for a project made without them", () => {
    expect(samplesLeft(project, { t1: task("t1", "GS-1", "u1", { deleted_at: 6 }) }, members)).toBeNull();
    expect(samplesLeft({ ...project, samples: undefined }, { t1: task("t1", "GS-1") }, members)).toBeNull();
  });
});

describe("asking for the samples", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStore();
    loadBootstrap("acme", {
      seq: 10,
      me: { user_id: "u1" } as Member,
      user: { id: "u1" } as User,
      workspace: { id: "w", slug: "acme" } as Workspace,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("gives the project once the feed has brought its samples", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ project });
    let given: Project | undefined;
    void addSamples().then((p) => (given = p));
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledWith("/api/v1/w/acme/samples", {});
    expect(given).toBeUndefined();

    const created = event(11, {
      type: "project.created",
      entity_type: "project",
      entity_id: "p",
      data: { row: { ...project, samples: undefined } },
    });
    applyEvents([created], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(given).toBeUndefined();

    const named = event(12, {
      type: "project.updated",
      entity_type: "project",
      entity_id: "p",
      data: { id: "p", changes: { samples: { from: null, to: project.samples } } },
    });
    applyEvents([named], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(given).toEqual(project);
  });

  it("stops waiting after a while when the feed brings nothing", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ project });
    let given: Project | undefined;
    void addSamples().then((p) => (given = p));
    await vi.advanceTimersByTimeAsync(4000);
    expect(given).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(given).toEqual(project);
  });
});
