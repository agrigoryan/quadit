// The block editor of a page: BlockNote, dressed in this product's tokens,
// kept in step with the server by editor/sync.ts. This file and everything
// it imports from @blocknote is loaded only when a page is opened.

import "@blocknote/mantine/style.css";
import "@/docs/editor/theme.css";

import { filterSuggestionItems } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import {
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { uploadFile } from "@/data/files";
import { t } from "@/lib/i18n";
import { type BlockSchemaLike, type EdBlock, plainText, rowsToEditor } from "@/docs/editor/convert";
import { Markers } from "@/docs/editor/markers";
import {
  ActionsContext,
  BlockSideMenu,
  decisionItems,
  type EditorActions,
  extraSlashItems,
  hashOpensDecisions,
  mentionItems,
  pageTitleItems,
  QuietMenu,
  SelectionToolbar,
} from "@/docs/editor/menus";
import { openChipAtCaret } from "@/docs/editor/chips";
import { type ChipKind, ChipPicker } from "@/docs/editor/pickers";
import { schema } from "@/docs/editor/schema";
import { DocSync, type SaveState } from "@/docs/editor/sync";
import { chipTyped } from "@/docs/editor/task-keys";
import { useThemeName } from "@/docs/editor/use-theme";
import type { BlockRow, PresenceEntry } from "@/types/docs";

export interface EditorHandle {
  scrollToBlock: (id: string) => void;
  /** A block's text, for the quote above a comment thread; undefined when the block is gone. */
  blockText: (id: string) => string | undefined;
  /** Block ids in reading order. */
  order: () => string[];
}

interface Props {
  docId: string;
  /**
   * The page's blocks as fetched, and its content position then: where the
   * editor and its sync start. Read when the editor is made; changing them
   * later does not load the page again (give the Editor a new key for that).
   */
  rows: BlockRow[];
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

export default function Editor({
  docId,
  rows,
  seq,
  readOnly,
  handle,
  onSaveState,
  onFocusBlock,
  onComment,
  threads,
  onOpenThread,
  others,
}: Props) {
  const theme = useThemeName();
  const wrap = useRef<HTMLDivElement | null>(null);
  const [picking, setPicking] = useState<ChipKind | null>(null);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the rows are the page as it was when opened; later changes arrive through the sync
  const initial = useMemo(() => rowsToEditor(rows, blockSchema), []);

  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: initial.length ? (initial as never[]) : undefined,
      uploadFile: upload,
      tables: { headers: true },
      animations: false,
      domAttributes: { editor: { "aria-label": t("docs.body.label") } },
      extensions: [openChipAtCaret],
    },
    [],
  );

  // In development the editor is reachable from the console, for poking at sync by hand.
  if (import.meta.env.DEV) (window as unknown as { __qdEditor?: unknown }).__qdEditor = editor;

  const callbacks = useRef({ onSaveState, onFocusBlock, onComment });
  callbacks.current = { onSaveState, onFocusBlock, onComment };

  useEffect(() => {
    // A page that cannot be edited here still follows what others (or the server) write in it. One
    // sync lasts as long as the page is open: the page turning read-only or editable again does not
    // start another from the blocks first fetched, which the editor has moved on from (sync.ts sends
    // what was typed before the turn).
    const sync = new DocSync(editor, docId, rows, seq, (state) => callbacks.current.onSaveState?.(state));
    const dom = editor.domElement;
    const onBlur = () => sync.flush();
    const onInput = () => setTimeout(() => chipTyped(editor), 0);
    dom?.addEventListener("focusout", onBlur);
    dom?.addEventListener("input", onInput);
    return () => {
      dom?.removeEventListener("focusout", onBlur);
      dom?.removeEventListener("input", onInput);
      sync.destroy();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the editor is made once per mounted page; rows and seq are its starting point
  }, [editor, docId]);

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
        // The flash is an animation, not a class: the editor puts back any
        // attribute changed on its blocks from outside, at once.
        el.querySelector(":scope > .bn-block > .bn-block-content")?.animate(
          [{ background: "var(--move-soft)" }, { background: "transparent" }],
          { duration: 1600, easing: "ease-out" },
        );
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

  const canComment = !!onComment;
  const actions = useMemo<EditorActions>(
    () => ({
      comment: canComment ? (blockId) => callbacks.current.onComment?.(blockId) : undefined,
      pickTask: () => setPicking("task"),
      pickDecision: () => setPicking("decision"),
      pickPage: () => setPicking("page"),
    }),
    [canComment],
  );

  function insertChip(kind: ChipKind, ref: string) {
    setPicking(null);
    // After the dialog has given the focus back.
    setTimeout(() => {
      editor.focus();
      const chip =
        kind === "task"
          ? { type: "taskChip", props: { key: ref } }
          : kind === "decision"
            ? { type: "decisionChip", props: { key: ref } }
            : { type: "pageLink", props: { doc: ref } };
      editor.insertInlineContent([chip, " "] as never);
    }, 30);
  }

  return (
    <div ref={wrap} className="qd-editor relative">
      <ActionsContext.Provider value={actions}>
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme={theme}
          slashMenu={false}
          formattingToolbar={false}
          sideMenu={false}
        >
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) =>
              filterSuggestionItems(
                [
                  ...getDefaultReactSlashMenuItems(editor).filter(
                    (item) => !/^toggle/.test((item as { key?: string }).key ?? ""),
                  ),
                  ...extraSlashItems(actions),
                ],
                query,
              )
            }
          />
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={async (query) => filterSuggestionItems(mentionItems(editor), query)}
          />
          <SuggestionMenuController
            triggerCharacter="#"
            shouldOpen={() => hashOpensDecisions(editor)}
            getItems={async (query) => decisionItems(editor, query)}
            suggestionMenuComponent={QuietMenu}
          />
          <SuggestionMenuController
            triggerCharacter="[["
            getItems={async (query) => pageTitleItems(editor, query, docId)}
            suggestionMenuComponent={QuietMenu}
          />
          <FormattingToolbarController formattingToolbar={SelectionToolbar} />
          <SideMenuController sideMenu={BlockSideMenu} />
        </BlockNoteView>
      </ActionsContext.Provider>
      <Markers editor={editor} wrap={wrap} others={others ?? []} threads={threads ?? {}} onOpenThread={onOpenThread} />
      <ChipPicker kind={picking} onClose={() => setPicking(null)} onPick={insertChip} />
    </div>
  );
}
