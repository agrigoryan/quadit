// @vitest-environment jsdom
// The words of a selection, counted as the server counts a block's text
// (docs/editor/words.ts): characters, a mention as its @handle; and the
// words a thread is on, read back from the style that marks them.

import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import type { EdBlock } from "@/docs/editor/convert";
import { schema } from "@/docs/editor/schema";
import { selectedWords, threadText } from "@/docs/editor/words";

const make = () =>
  BlockNoteEditor.create({
    schema,
    initialContent: [
      {
        id: "b1",
        type: "paragraph",
        content: ["Ask ", { type: "mention", props: { handle: "ann" } }, " about the café plan."],
      },
      { id: "b2", type: "paragraph", content: "Then it runs." },
      { id: "b3", type: "codeBlock", content: "hp = 300" },
    ] as never[],
  });

/** Selects from the start of `from` (in the block that has it) to the end of `to`. */
function select(editor: ReturnType<typeof make>, from: string, to: string) {
  const at = (text: string, end: boolean) => {
    let found = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      const i = node.isText ? (node.text ?? "").indexOf(text) : -1;
      if (found < 0 && i >= 0) found = pos + i + (end ? text.length : 0);
      return found < 0;
    });
    return found;
  };
  editor._tiptapEditor.commands.setTextSelection({ from: at(from, false), to: at(to, true) });
}

describe("selectedWords", () => {
  it("counts a mention as its @handle and a letter with an accent as one character", () => {
    const editor = make();
    select(editor, "café", "plan");
    // "Ask @ann about the " is 19 characters.
    expect(selectedWords(editor)).toEqual({ block: "b1", start: 19, end: 28, quote: "café plan" });
    select(editor, "Ask", "about");
    expect(selectedWords(editor)).toEqual({ block: "b1", start: 0, end: 14, quote: "Ask @ann about" });
  });

  it("runs from one block into the next", () => {
    const editor = make();
    select(editor, "plan.", "Then");
    expect(selectedWords(editor)).toEqual({ block: "b1", start: 24, end: 4, endBlock: "b2", quote: "plan.\nThen" });
  });

  it("leaves a code block out", () => {
    const editor = make();
    select(editor, "runs", "300");
    expect(selectedWords(editor)).toEqual({ block: "b2", start: 8, end: 13, quote: "runs." });
    select(editor, "hp", "300");
    expect(selectedWords(editor)).toBeUndefined();
  });

  it("is nothing for no selection", () => {
    const editor = make();
    editor._tiptapEditor.commands.setTextSelection(3);
    expect(selectedWords(editor)).toBeUndefined();
  });
});

describe("the marker of a thread", () => {
  it("is kept in the editor's blocks, as the server sent it", () => {
    const editor = BlockNoteEditor.create({
      schema,
      initialContent: [
        { id: "b1", type: "paragraph", content: [{ type: "text", text: "boss", styles: { comment: "t1 t2" } }] },
      ] as never[],
    });
    expect(editor.document[0]?.content).toEqual([{ type: "text", text: "boss", styles: { comment: "t1 t2" } }]);
    expect(threadText(editor.document as unknown as EdBlock[], "t2")).toBe("boss"); // BlockNote types blocks by schema generics
  });
});

describe("threadText", () => {
  it("reads the words a thread is on, a stretch apart elsewhere joined", () => {
    const doc = [
      {
        id: "b1",
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "The ", styles: {} },
          { type: "text", text: "boss", styles: { comment: "t1 t2" } },
          { type: "text", text: " has", styles: { comment: "t1", bold: true } },
          { type: "text", text: " three", styles: {} },
        ],
        children: [
          {
            id: "b2",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text: "phases", styles: { comment: "t1" } }],
            children: [],
          },
        ],
      },
    ] as EdBlock[];
    expect(threadText(doc, "t1")).toBe("boss has … phases");
    expect(threadText(doc, "t2")).toBe("boss");
    expect(threadText(doc, "t3")).toBeUndefined();
  });
});
