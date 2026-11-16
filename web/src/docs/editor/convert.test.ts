// Server blocks into the editor and back (docs/editor/convert.ts): code that
// Markdown stored with other marks around it ("**bold `code` bold**") or in
// a link opens in the page's editor as it is, and is stored back unchanged.

import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import { type BlockSchemaLike, type EdBlock, toEditor, toWire } from "@/docs/editor/convert";
import { schema } from "@/docs/editor/schema";

const blocks = schema.blockSchema as unknown as BlockSchemaLike;

/** A paragraph of `content` opened in the page's editor and read back as the server would store it. */
function roundTrip(content: unknown[]): unknown {
  const block = toEditor({ id: "b1", type: "paragraph", props: {}, content }, blocks);
  const editor = BlockNoteEditor.create({ schema, initialContent: [{ ...block, children: [] } as never] });
  return toWire(editor.document[0] as unknown as EdBlock, blocks).content;
}

describe("a paragraph through the editor", () => {
  it.each([
    [
      "bold around code",
      [
        { type: "text", text: "bold ", styles: { bold: true } },
        { type: "text", text: "code", styles: { bold: true, code: true } },
        { type: "text", text: " bold", styles: { bold: true } },
      ],
    ],
    ["italic around code", [{ type: "text", text: "code", styles: { code: true, italic: true } }]],
    ["strike around code", [{ type: "text", text: "code", styles: { code: true, strike: true } }]],
    [
      "code in a link",
      [
        {
          type: "link",
          href: "https://example.com",
          content: [{ type: "text", text: "code", styles: { code: true } }],
        },
      ],
    ],
    [
      "code alone",
      [
        { type: "text", text: "see " },
        { type: "text", text: "SVA-1 @ann", styles: { code: true } },
      ],
    ],
  ])("keeps %s", (_, content) => {
    expect(roundTrip(content)).toEqual(content);
  });
});
