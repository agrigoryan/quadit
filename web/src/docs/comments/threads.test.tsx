// @vitest-environment jsdom
// A page's threads (docs/comments/threads.ts): what the text reads as for
// them is read once for all who show them, in one walk a frame at most, and
// not at all while no open thread is on the text; a thread open that is
// resolved or deleted meanwhile, by someone else, is open no more: nothing
// is left showing it, and Esc is the page's again.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearStore, loadBootstrap } from "@/data/store";
import type { Comment, Member, User, Workspace } from "@/types/core";
import { useLeaveGoneThread, usePageThreads, useReadThreads, useThreadReadings } from "@/docs/comments/threads";
import type { EditorHandle } from "@/docs/editor/editor";
import { pageUi, usePageUi } from "@/docs/page/state";

const me = { user_id: "u1", role: "owner", name: "Aram", kind: "person", handle: "aram" } as Member;
const root = {
  id: "c1",
  doc_id: "d1",
  subject_type: "doc",
  subject_id: "d1",
  kind: "comment",
  author_id: "u1",
  body: "Short page.",
  created_at: 1,
} as Comment;

/** The workspace as the server has it now, with these comments. */
const load = (comments: Comment[]) => {
  clearStore();
  loadBootstrap("acme", {
    seq: 1,
    me,
    user: { id: "u1" } as User,
    workspace: { id: "w", slug: "acme", name: "Acme" } as Workspace,
    members: [me],
    comments,
  });
};

beforeEach(() => {
  pageUi.reset();
  load([root]);
});

describe("useLeaveGoneThread", () => {
  it("keeps a thread that is still there, and leaves one resolved meanwhile", () => {
    renderHook(() => useLeaveGoneThread());
    act(() => pageUi.openThread("c1"));
    expect(usePageUi.getState().focusThread).toBe("c1");
    act(() => load([{ ...root, body: "Short page, edited." }]));
    expect(usePageUi.getState().focusThread).toBe("c1");
    act(() => load([{ ...root, resolved_at: 3 }]));
    expect(usePageUi.getState().focusThread).toBeNull();
  });

  it("leaves a thread deleted meanwhile", () => {
    renderHook(() => useLeaveGoneThread());
    act(() => pageUi.openThread("c1"));
    act(() => load([]));
    expect(usePageUi.getState().focusThread).toBeNull();
  });
});

describe("useReadThreads", () => {
  /** An editor whose text changes when the test says, counting its reads. */
  const fake = () => {
    let changed = () => {};
    const editor = {
      read: vi.fn((blocks: string[], threads: string[]) => ({
        order: ["b1"],
        texts: new Map(blocks.map((id) => [id, "The boss has three phases"])),
        words: new Map(threads.map((id) => [id, "three phases"])),
      })),
      onChange: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    } as unknown as EditorHandle; // only reading is asked of it
    return { editor, change: () => changed() };
  };
  const frame = () => act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));

  beforeEach(() => useThreadReadings.setState({ byPage: {} }));

  it("reads nothing while no open thread is on the text", async () => {
    const { editor, change } = fake();
    renderHook(() => useReadThreads("d1", editor, false));
    act(() => change());
    await frame();
    expect(editor.read).not.toHaveBeenCalled();
  });

  it("reads every thread in one walk a frame, however many show them", async () => {
    load([
      root,
      { ...root, id: "c2", subject_type: "doc_block", subject_id: "b1" },
      { ...root, id: "c3", subject_type: "doc_block", subject_id: "b1", quote: "three phases" },
    ]);
    const { editor, change } = fake();
    const shown = renderHook(() => {
      useReadThreads("d1", editor, true);
      return [usePageThreads("d1"), usePageThreads("d1"), usePageThreads("d1")];
    });
    expect(editor.read).toHaveBeenCalledTimes(1);
    expect(editor.read).toHaveBeenCalledWith(["b1"], ["c3"]);
    act(() => {
      change();
      change();
    });
    await frame();
    expect(editor.read).toHaveBeenCalledTimes(2);
    expect(shown.result.current[0]?.open.find((th) => th.root.id === "c3")?.about).toEqual({
      on: "text",
      text: "three phases",
    });
  });
});
