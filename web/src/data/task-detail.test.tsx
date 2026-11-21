// @vitest-environment jsdom
// An opened task (data/task-detail.ts): its rows go to the store, its history
// and what mentions it are kept beside it (the history grows with live
// events), a failure says why, and the task is fetched again when the live
// stream comes back.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRowEvenIfGone } from "@/data/selectors";
import { applyEvents, clearStore, loadBootstrap, useStore } from "@/data/store";
import { useTaskDetail, useTaskEvents, useTaskMentions } from "@/data/task-detail";
import type { FeedEvent, Member, User, Workspace } from "@/types/core";
import { type FakeServer, fakeServer, refuse } from "@/test/fake-server";
import { WithQuery } from "@/test/query";

const TASK = "/api/v1/w/acme/tasks/t1?raw=1";
const EVENTS = "/api/v1/w/acme/events?task=t1&limit=500";

const raw = (comments: { id: string; body: string }[]) => ({
  task: { id: "t1", key: "SVA-1", project_id: "p1", title: "Ship", description: "the whole text", updated_seq: 1 },
  comments: comments.map((c) => ({ ...c, task_id: "t1" })),
  links: [],
  watchers: [],
  attachments: [],
  sessions: [],
  mentioned_in: [{ from_scope_type: "doc", from_scope_id: "d1", to_type: "task", to_id: "t1", title: "Plan" }],
});

const event = (seq: number) =>
  ({ seq, type: "comment.created", scope_type: "task", scope_id: "t1", entity_type: "comment" }) as FeedEvent;

let server: FakeServer;

beforeEach(() => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me: { user_id: "u1", role: "member", name: "Ann", kind: "person", handle: "ann" } as Member,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme" } as Workspace,
    tasks: [{ id: "t1", key: "SVA-1", project_id: "p1", title: "Ship", updated_seq: 1 }],
    comments: [{ id: "c-gone", task_id: "t1", body: "deleted meanwhile" }],
  });
  useStore.setState({ stream: "live" });
  server = fakeServer();
});

afterEach(() => vi.unstubAllGlobals());

const open = () =>
  renderHook(() => ({ status: useTaskDetail("t1"), events: useTaskEvents("t1"), mentions: useTaskMentions("t1") }), {
    wrapper: WithQuery,
  });

describe("useTaskDetail", () => {
  it("puts the task's rows in the store and keeps its history, with live events added", async () => {
    server.get(TASK, raw([{ id: "c1", body: "hello" }]));
    server.get(EVENTS, { events: [event(1)] });
    const { result } = open();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(getRowEvenIfGone("tasks", "t1")?.description).toBe("the whole text");
    expect(getRowEvenIfGone("comments", "c1")?.body).toBe("hello");
    expect(getRowEvenIfGone("comments", "c-gone")).toBeUndefined();
    expect(result.current.events.map((e) => e.seq)).toEqual([1]);
    act(() => applyEvents([{ ...event(2), data: { row: { id: "c2", task_id: "t1", body: "more" } } }], true));
    await waitFor(() => expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]));
    expect(result.current.mentions.map((m) => m.title)).toEqual(["Plan"]);
    // One fetch for every reader of the task.
    expect(server.count(TASK)).toBe(1);
  });

  it("says why the task could not be read, and reads it when the stream is back", async () => {
    server.get(TASK, refuse(500, "database is down"));
    server.get(EVENTS, { events: [] });
    const { result } = open();
    await waitFor(() => expect(result.current.status).toBe("database is down"));
    server.get(TASK, raw([]));
    act(() => useStore.setState({ stream: "down" }));
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("says it waits while the server cannot be reached, asking nothing, and reads the task once it can", async () => {
    server.get(TASK, raw([]));
    server.get(EVENTS, { events: [] });
    act(() => useStore.setState({ stream: "down" }));
    const { result } = open();
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    expect(server.count(TASK)).toBe(0);
    act(() => useStore.setState({ stream: "live" }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("keeps saying it loads after a 401: the person is on the way to sign in", async () => {
    server.get(TASK, refuse(401, "signed out"));
    server.get(EVENTS, { events: [] });
    const { result } = open();
    await waitFor(() => expect(server.count(TASK)).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.status).toBe("loading");
  });
});
