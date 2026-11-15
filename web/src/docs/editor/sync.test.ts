// @vitest-environment jsdom
// Keeping an open page in step with the server (docs/editor/sync.ts) when the
// page stops being editable while it is open (its project's access changed,
// it became a mirror of a read-only file): what was typed before still goes
// out, once, and nothing is sent again.

import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutate } from "@/data/mutate";
import { schema } from "@/docs/editor/schema";
import { DocSync } from "@/docs/editor/sync";
import type { BlockRow } from "@/types/docs";

vi.mock("@/data/mutate", () => ({ mutate: vi.fn(() => Promise.resolve([{ seq: 10 }])) }));
vi.mock("@/docs/store", () => ({ loadPage: vi.fn() }));

const row = (id: string, rank: string, text: string, seq: number): BlockRow => ({
  id,
  doc_id: "d1",
  rank,
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
  created_by: "u1",
  updated_by: "u1",
  created_seq: seq,
  updated_seq: seq,
});

/** The doc.edit ops sent so far, one list per change. */
const sent = () =>
  vi.mocked(mutate).mock.calls.map(([change]) => (change as { args: { ops: { op: string; id?: string }[] } }).args.ops);

const make = (rows: BlockRow[]) =>
  BlockNoteEditor.create({
    schema,
    initialContent: rows.map((r) => ({
      id: r.id,
      type: "paragraph",
      content: (r.content as { text: string }[])[0]?.text,
    })) as never[],
  });

const typeInto = (editor: ReturnType<typeof make>, id: string, text: string) =>
  editor.updateBlock(id, { content: text });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(mutate).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("a page that stops being editable while open", () => {
  it("sends an edit once, while it can be edited", async () => {
    const rows = [row("b1", "a", "Hello", 1)];
    const editor = make(rows);
    const sync = new DocSync(editor, "d1", rows, 1);
    typeInto(editor, "b1", "Hello world");
    await vi.advanceTimersByTimeAsync(1000);
    sync.flush();
    expect(sent()).toEqual([[expect.objectContaining({ op: "update", id: "b1" })]]);
    sync.destroy();
  });

  it("still sends what was typed just before", async () => {
    const rows = [row("b1", "a", "Hello", 1)];
    const editor = make(rows);
    const sync = new DocSync(editor, "d1", rows, 1);
    typeInto(editor, "b1", "Hello world");
    editor.isEditable = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toEqual([[expect.objectContaining({ op: "update", id: "b1" })]]);
    sync.destroy();
  });

  it("sends nothing of its own once it cannot be edited", async () => {
    const rows = [row("b1", "a", "Hello", 1)];
    const editor = make(rows);
    editor.isEditable = false;
    const sync = new DocSync(editor, "d1", rows, 1);
    sync.flush();
    sync.destroy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toEqual([]);
  });
});
