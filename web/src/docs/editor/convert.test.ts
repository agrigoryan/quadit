// Server blocks into the editor (docs/editor/convert.ts): code that Markdown
// stored with other marks around it ("**bold `code` bold**") or in a link
// still opens.

import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import { type BlockSchemaLike, toEditor } from "@/docs/editor/convert";

const schema = BlockNoteEditor.create().schema.blockSchema as unknown as BlockSchemaLike; // the default blocks are enough here

describe("toEditor", () => {
  it("opens code with marks around it as code alone, and code in a link as the link's text: the editor's code mark excludes every other", () => {
    const block = toEditor(
      {
        id: "b1",
        type: "paragraph",
        props: {},
        content: [
          { type: "text", text: "bold ", styles: { bold: true } },
          { type: "text", text: "code", styles: { bold: true, code: true } },
          {
            type: "link",
            href: "https://x.io",
            content: [{ type: "text", text: "c", styles: { italic: true, code: true } }],
          },
        ],
      },
      schema,
    );
    expect(block.content).toEqual([
      { type: "text", text: "bold ", styles: { bold: true } },
      { type: "text", text: "code", styles: { code: true } },
      { type: "link", href: "https://x.io", content: [{ type: "text", text: "c", styles: { italic: true } }] },
    ]);
    expect(() => BlockNoteEditor.create({ initialContent: [{ ...block, children: [] } as never] })).not.toThrow();
  });
});
