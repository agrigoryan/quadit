// @vitest-environment jsdom
// Keeping an open page in step with the server (docs/editor/sync.ts): when
// the page stops being editable while it is open (its project's access
// changed, it became a mirror of a read-only file), what was typed before
// still goes out, once, and nothing is sent again; when the server writes a
// block otherwise than it was sent (a comment thread's marker put back), the
// editor takes it without losing what was typed since or moving the caret.

import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutate } from "@/data/mutate";
import { applyEvents } from "@/data/store";
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

describe("a block the server writes otherwise than it was sent", () => {
  it("is taken into the editor: a comment thread's marker the server put back on its words", async () => {
    const rows = [row("b1", "a", "The boss has three phases.", 1)];
    const editor = make(rows);
    const sync = new DocSync(editor, "d1", rows, 1);
    const marked = [
      { type: "text", text: "The boss has " },
      { type: "text", text: "three phases", styles: { comment: "t1" } },
      { type: "text", text: " now." },
    ];
    vi.mocked(mutate).mockImplementationOnce(() =>
      Promise.resolve([
        {
          change_id: "c",
          type: "doc.edit",
          seq: 10,
          first_seq: 10,
          events: [
            {
              seq: 10,
              type: "doc.edited",
              entity_id: "d1",
              data: { blocks: [{ ...row("b1", "a", "", 10), content: marked }] },
            },
          ],
        },
      ] as never),
    );
    typeInto(editor, "b1", "The boss has three phases now.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(editor.getBlock("b1")?.content).toEqual([
      { type: "text", text: "The boss has ", styles: {} },
      { type: "text", text: "three phases", styles: { comment: "t1" } },
      { type: "text", text: " now.", styles: {} },
    ]);
    sync.flush();
    expect(sent()).toHaveLength(1); // taking the server's block sends nothing back
    sync.destroy();
  });
});

/** The answer to a doc.edit that wrote one block as `content`, at `seq`. */
const answer = (id: string, seq: number, content: unknown[]) => [
  {
    change_id: "c",
    type: "doc.edit",
    seq,
    first_seq: seq,
    events: [{ seq, type: "doc.edited", entity_id: "d1", data: { blocks: [{ ...row(id, "a", "", seq), content }] } }],
  },
];

/** Holds the next doc.edit's answer until `answer` is called with it. */
function holdNextAnswer() {
  let give: (results: unknown) => void = () => {};
  vi.mocked(mutate).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        give = resolve;
      }) as never,
  );
  return (results: unknown) => give(results);
}

/** Where the caret is in a block's text, in characters; undefined when it is elsewhere. */
function caretIn(editor: ReturnType<typeof make>, id: string): number | undefined {
  const { selection, doc } = editor.prosemirrorState;
  const at = getNodeById(id, doc);
  if (!at) return undefined;
  const start = at.posBeforeNode + 2;
  return selection.empty ? selection.from - start : undefined;
}

/** Puts the caret in a block's text, `offset` characters in. */
function putCaret(editor: ReturnType<typeof make>, id: string, offset: number) {
  editor.transact((tr) => {
    const at = getNodeById(id, tr.doc);
    if (!at) throw new Error(`no block ${id}`);
    const Sel = tr.selection.constructor as unknown as { create(doc: unknown, pos: number): never }; // ProseMirror's TextSelection, which BlockNote does not export
    tr.setSelection(Sel.create(tr.doc, at.posBeforeNode + 2 + offset));
  });
}

const textOf = (editor: ReturnType<typeof make>, id: string) =>
  ((editor.getBlock(id)?.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("");

describe("a block the server writes otherwise than it was sent, while the person types", () => {
  const marked = (rest: string) => [
    { type: "text", text: "The boss has " },
    { type: "text", text: "three phases", styles: { comment: "t1" } },
    { type: "text", text: rest },
  ];

  it("keeps the caret where it was when nothing was typed since", async () => {
    const rows = [row("b1", "a", "The boss has three phases.", 1)];
    const editor = make(rows);
    const sync = new DocSync(editor, "d1", rows, 1);
    const give = holdNextAnswer();
    typeInto(editor, "b1", "The boss has three phases now.");
    await vi.advanceTimersByTimeAsync(1000);
    putCaret(editor, "b1", 15); // inside the marked words
    give(answer("b1", 10, marked(" now.")));
    await vi.advanceTimersByTimeAsync(0);
    expect(editor.getBlock("b1")?.content).toContainEqual({
      type: "text",
      text: "three phases",
      styles: { comment: "t1" },
    });
    expect(caretIn(editor, "b1")).toBe(15);
    sync.destroy();
  });

  it("never takes back what was typed while the edit was on its way, and takes the marker with the next answer", async () => {
    const rows = [row("b1", "a", "The boss has three phases.", 1)];
    const editor = make(rows);
    const sync = new DocSync(editor, "d1", rows, 1);
    const give = holdNextAnswer();
    typeInto(editor, "b1", "The boss has three phases now.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toHaveLength(1);
    // Typing goes on before the answer comes.
    typeInto(editor, "b1", "The boss has three phases now and then.");
    putCaret(editor, "b1", 38);
    give(answer("b1", 10, marked(" now.")));
    await vi.advanceTimersByTimeAsync(0);
    expect(textOf(editor, "b1")).toBe("The boss has three phases now and then.");
    expect(caretIn(editor, "b1")).toBe(38);
    // The newer text goes out; its answer, with the marker, is taken as nothing was typed since.
    vi.mocked(mutate).mockImplementationOnce(
      () => Promise.resolve(answer("b1", 11, marked(" now and then."))) as never,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toHaveLength(2);
    expect(textOf(editor, "b1")).toBe("The boss has three phases now and then.");
    expect(editor.getBlock("b1")?.content).toContainEqual({
      type: "text",
      text: "three phases",
      styles: { comment: "t1" },
    });
    expect(caretIn(editor, "b1")).toBe(38);
    sync.destroy();
  });

  it("leaves the person's undo as it was: an undo takes back what they typed and keeps the marker", async () => {
    const rows = [row("b1", "a", "The boss has three phases.", 1)];
    const editor = make(rows);
    editor.mount(document.createElement("div")); // the editor keeps its undo history once it is on a page
    const sync = new DocSync(editor, "d1", rows, 1);
    vi.mocked(mutate).mockImplementationOnce(() => Promise.resolve(answer("b1", 10, marked(". Now"))) as never);
    editor.setTextCursorPosition("b1", "end");
    editor.insertInlineContent(" Now");
    await vi.advanceTimersByTimeAsync(1000);
    expect(editor.getBlock("b1")?.content).toContainEqual({
      type: "text",
      text: "three phases",
      styles: { comment: "t1" },
    });
    editor.undo();
    expect(textOf(editor, "b1")).toBe("The boss has three phases.");
    expect(editor.getBlock("b1")?.content).toContainEqual({
      type: "text",
      text: "three phases",
      styles: { comment: "t1" },
    });
    sync.destroy();
  });

  it("does not take it over someone else's later edit of the block that came while it was on its way", async () => {
    const rows = [row("b1", "a", "The boss has three phases.", 1)];
    const editor = make(rows);
    const sync = new DocSync(editor, "d1", rows, 1);
    const give = holdNextAnswer();
    typeInto(editor, "b1", "The boss has three phases now.");
    await vi.advanceTimersByTimeAsync(1000);
    applyEvents(
      [
        {
          seq: 11,
          change_id: "theirs",
          type: "doc.edited",
          entity_type: "doc",
          entity_id: "d1",
          data: { blocks: [row("b1", "a", "Their words.", 11)] },
        } as never,
      ],
      true,
    );
    give(answer("b1", 10, marked(" now.")));
    await vi.advanceTimersByTimeAsync(0);
    expect(textOf(editor, "b1")).toBe("Their words.");
    sync.destroy();
  });
});
