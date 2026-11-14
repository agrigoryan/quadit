// A page's blocks shown read-only: a kept version in the history dialog.

import "@blocknote/mantine/style.css";
import "@/docs/editor/theme.css";

import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useMemo } from "react";
import { type BlockSchemaLike, treeToEditor } from "@/docs/editor/convert";
import { schema } from "@/docs/editor/schema";
import { useThemeName } from "@/docs/editor/use-theme";
import type { BlockTree } from "@/docs/types";

export default function Preview({ blocks }: { blocks: BlockTree[] }) {
  const theme = useThemeName();
  const initial = useMemo(() => treeToEditor(blocks, schema.blockSchema as unknown as BlockSchemaLike), [blocks]);
  const editor = useCreateBlockNote({ schema, initialContent: initial.length ? (initial as never[]) : undefined, trailingBlock: false, animations: false }, [initial]);
  return (
    <div className="qd-editor">
      <BlockNoteView editor={editor} editable={false} theme={theme} />
    </div>
  );
}
