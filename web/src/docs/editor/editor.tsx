// The block editor of a page: BlockNote, dressed in this product's tokens,
// kept in step with the server by editor/sync.ts. This file and everything
// it imports from @blocknote is loaded only when a page is opened.

import "@blocknote/mantine/style.css";
import "@/docs/editor/theme.css";

import { filterSuggestionItems } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import {
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { uploadFile } from "@/lib/files";
import { newId } from "@/lib/ids";
import { type BlockSchemaLike, type EdBlock, plainText, rowsToEditor } from "@/docs/editor/convert";
import { Markers } from "@/docs/editor/markers";
import { ActionsContext, BlockMenu, CommentButton, type EditorActions, extraSlashItems, mentionItems } from "@/docs/editor/menus";
import { type ChipKind, ChipPicker } from "@/docs/editor/pickers";
import { schema } from "@/docs/editor/schema";
import { DocSync, type SaveState } from "@/docs/editor/sync";
import { chipTypedTaskKey } from "@/docs/editor/task-keys";
import { useThemeName } from "@/docs/editor/use-theme";
import type { BlockRow, PresenceEntry } from "@/docs/types";

export interface EditorHandle {
  scrollToBlock: (id: string) => void;
  /** A block's text, for the quote above a comment thread; undefined when the block is gone. */
  blockText: (id: string) => string | undefined;
  /** Block ids in reading order. */
  order: () => string[];
}

interface Props {
  docId: string;
  rows: BlockRow[];
  /** The page's content position when the rows were fetched. */
  seq: number;
  readOnly: boolean;
  handle?: Ref<EditorHandle>;
  onSaveState?: (state: SaveState) => void;
  onFocusBlock?: (id: string | null) => void;
  onComment?: (blockId: string) => void;
  /** Open comment threads per block. */
  threads?: Record<string, number>;
  onOpenThread?: (blockId: string) => void;
  others?: PresenceEntry[];
}

const blockSchema = schema.blockSchema as unknown as BlockSchemaLike;

async function upload(file: File) {
  const row = await uploadFile(file);
  return { props: { url: row.url, name: row.name } };
}

export default function Editor({ docId, rows, seq, readOnly, handle, onSaveState, onFocusBlock, onComment, threads, onOpenThread, others }: Props) {
  const theme = useThemeName();
  const wrap = useRef<HTMLDivElement | null>(null);
  const [picking, setPicking] = useState<ChipKind | null>(null);
  // The rows are the page as it was when opened; later changes arrive through the sync.
  const initial = useMemo(() => rowsToEditor(rows, blockSchema), []); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: initial.length ? (initial as never[]) : undefined,
      uploadFile: upload,
      tables: { headers: true },
      animations: false,
    },
    [],
  );

  // New blocks get ids like every other row of the product (UUIDv7), made here.
  useMemo(() => {
    const ids = editor._tiptapEditor.extensionManager.extensions.find((e) => e.name === "uniqueID");
    if (ids) (ids.options as { generateID: () => string }).generateID = newId;
  }, [editor]);

  // In development the editor is reachable from the console, for poking at sync by hand.
  if (import.meta.env.DEV) (window as unknown as { __qdEditor?: unknown }).__qdEditor = editor;

  const callbacks = useRef({ onSaveState, onFocusBlock, onComment });
  callbacks.current = { onSaveState, onFocusBlock, onComment };

  useEffect(() => {
    if (readOnly) return;
    const sync = new DocSync(editor, docId, rows, seq, (state) => callbacks.current.onSaveState?.(state));
    const dom = editor.domElement;
    const onBlur = () => sync.flush();
    const onInput = () => setTimeout(() => chipTypedTaskKey(editor), 0);
    dom?.addEventListener("focusout", onBlur);
    dom?.addEventListener("input", onInput);
    return () => {
      dom?.removeEventListener("focusout", onBlur);
      dom?.removeEventListener("input", onInput);
      sync.destroy();
    };
    // The editor is made once per mounted page; rows and seq are its starting point.
  }, [editor, docId, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which block the caret is in, for presence.
  useEffect(() => {
    let last: string | null = null;
    const report = () => {
      const id = editor.isFocused() ? editor.getTextCursorPosition().block.id : null;
      if (id !== last) callbacks.current.onFocusBlock?.((last = id));
    };
    const offSel = editor.onSelectionChange(report);
    const dom = editor.domElement;
    dom?.addEventListener("focusin", report);
    dom?.addEventListener("focusout", report);
    return () => {
      offSel();
      dom?.removeEventListener("focusin", report);
      dom?.removeEventListener("focusout", report);
    };
  }, [editor]);

  useImperativeHandle(
    handle,
    () => ({
      scrollToBlock(id) {
        const el = wrap.current?.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.remove("qd-flash");
        void el.offsetWidth;
        el.classList.add("qd-flash");
      },
      blockText(id) {
        const block = editor.getBlock(id) as unknown as EdBlock | undefined;
        return block ? plainText(block.content) : undefined;
      },
      order() {
        const out: string[] = [];
        editor.forEachBlock((b) => {
          out.push(b.id);
          return true;
        });
        return out;
      },
    }),
    [editor],
  );

  const actions = useMemo<EditorActions>(
    () => ({
      comment: (blockId) => callbacks.current.onComment?.(blockId),
      pickTask: () => setPicking("task"),
      pickPage: () => setPicking("page"),
    }),
    [],
  );

  function insertChip(kind: ChipKind, ref: string) {
    setPicking(null);
    // After the dialog has given the focus back.
    setTimeout(() => {
      editor.focus();
      const chip = kind === "task" ? { type: "taskChip", props: { key: ref } } : { type: "pageLink", props: { doc: ref } };
      editor.insertInlineContent([chip, " "] as never);
    }, 30);
  }

  return (
    <div ref={wrap} className="qd-editor relative">
      <ActionsContext.Provider value={actions}>
        <BlockNoteView editor={editor} editable={!readOnly} theme={theme} slashMenu={false} formattingToolbar={false} sideMenu={false}>
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [...getDefaultReactSlashMenuItems(editor).filter((item) => !/^toggle/.test((item as { key?: string }).key ?? "")), ...extraSlashItems(actions)],
                query,
              )
            }
          />
          <SuggestionMenuController triggerCharacter="@" getItems={async (query) => filterSuggestionItems(mentionItems(editor), query)} />
          <FormattingToolbarController
            formattingToolbar={() => <FormattingToolbar>{[...getFormattingToolbarItems(), ...(onComment ? [<CommentButton key="qdComment" />] : [])]}</FormattingToolbar>}
          />
          <SideMenuController sideMenu={(props) => <SideMenu {...props} dragHandleMenu={BlockMenu} />} />
        </BlockNoteView>
      </ActionsContext.Provider>
      <Markers editor={editor} wrap={wrap} others={others ?? []} threads={threads ?? {}} onOpenThread={onOpenThread} />
      <ChipPicker kind={picking} onClose={() => setPicking(null)} onPick={insertChip} />
    </div>
  );
}
