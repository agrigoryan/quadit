// The block editor of a page: BlockNote, dressed in this product's tokens,
// kept in step with the server by editor/sync.ts. This file and everything
// it imports from @blocknote is loaded only when a page is opened.

import "@blocknote/mantine/style.css";
import "@/docs/editor/theme.css";

import { filterSuggestionItems, FormattingToolbarExtension, SideMenuExtension } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import {
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
  useExtensionState,
} from "@blocknote/react";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { uploadFile } from "@/data/files";
import { t } from "@/lib/i18n";
import { scrollBehavior } from "@/lib/motion";
import { type BlockSchemaLike, type EdBlock, rowsToEditor } from "@/docs/editor/convert";
import { Highlights } from "@/docs/editor/highlights";
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
import { readThreads, selectedWords, type ThreadReading, type Words } from "@/docs/editor/words";
import type { BlockRow, PresenceEntry } from "@/types/docs";

export interface EditorHandle {
  scrollToBlock: (id: string) => void;
  /** Scrolls to the words a comment thread is on, and flashes them. */
  scrollToThread: (threadId: string) => void;
  /** What the comment threads on these blocks and words read as now, in one walk of the page (words.ts). */
  read: (blocks: string[], threads: string[]) => ThreadReading;
  /** The words selected in the text this moment, for a thread on them; undefined for none, or a selection elsewhere. */
  selectedWords: () => Words | undefined;
  /** Calls `listener` after each change of the page's text; gives what stops it. */
  onChange: (listener: () => void) => () => void;
  /**
   * The block the caret is in, as the browser has it this moment; null when
   * the text does not have the focus. A key pressed right after the caret
   * moved is about the block the caret is in now, which the editor and the
   * page hear of only a moment later.
   */
  caretBlock: () => string | null;
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
  /** Starts a thread on a block, or on words of it. */
  onComment?: (blockId: string, words?: Words) => void;
  /** Open comment threads per block. */
  threads?: Record<string, number>;
  /** Whether a block's count of threads shows at its end (not where threads are cards beside the text). */
  countThreads?: boolean;
  onOpenThread?: (blockId: string) => void;
  /** The open threads on words, whose words are highlighted, the one the pointer is on and the one shown. */
  wordThreads?: string[];
  litThread?: string | null;
  activeThread?: string | null;
  /** Shows the thread whose words were clicked. */
  onShowThread?: (threadId: string) => void;
  /** The pointer came onto the words of a thread, or left them (null). */
  onLightThread?: (threadId: string | null) => void;
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
  countThreads,
  onOpenThread,
  wordThreads,
  litThread,
  activeThread,
  onShowThread,
  onLightThread,
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
        el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
        // The flash is an animation, not a class: the editor puts back any
        // attribute changed on its blocks from outside, at once.
        el.querySelector(":scope > .bn-block > .bn-block-content")?.animate(
          [{ background: "var(--move-soft)" }, { background: "transparent" }],
          { duration: 1600, easing: "ease-out" },
        );
      },
      scrollToThread(threadId) {
        const marked = wrap.current?.querySelectorAll<HTMLElement>(
          `[data-style-type="comment"][data-value~="${CSS.escape(threadId)}"]`,
        );
        const first = marked?.[0];
        if (!first) return;
        first.scrollIntoView({ block: "center", behavior: scrollBehavior() });
        // A ring, not a background: the words of the thread shown have the highlighter already.
        for (const el of marked)
          el.animate([{ boxShadow: "0 0 0 3px var(--move)" }, { boxShadow: "0 0 0 3px transparent" }], {
            duration: 1600,
            easing: "ease-out",
          });
      },
      read(blocks, threads) {
        return readThreads(editor.document as unknown as EdBlock[], blocks, threads); // BlockNote types blocks by schema generics
      },
      onChange(listener) {
        return editor.onChange(listener);
      },
      selectedWords() {
        // The editor keeps its last selection when the person selects or clicks elsewhere: only one
        // the browser shows in the text now counts.
        const shown = document.getSelection();
        if (!shown || shown.isCollapsed || !editor.domElement?.contains(shown.anchorNode)) return undefined;
        return selectedWords(editor);
      },
      caretBlock() {
        const at = document.getSelection()?.focusNode;
        const element = at instanceof Element ? at : at?.parentElement;
        if (!editor.isFocused() || !element || !editor.domElement?.contains(element)) return null;
        return element.closest<HTMLElement>(".bn-block-outer[data-id]")?.dataset.id ?? null;
      },
    }),
    [editor],
  );

  // The block the pointer is on, as the block's handle has it (none while typing or in a page that
  // cannot be edited), offered a thread unless words are selected: the selection's Comment is for those.
  const pointed = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => (state?.show ? state.block.id : undefined),
  });
  const selecting = useExtensionState(FormattingToolbarExtension, { editor });

  const canComment = !!onComment;
  const actions = useMemo<EditorActions>(
    () => ({
      comment: canComment ? (blockId, words) => callbacks.current.onComment?.(blockId, words) : undefined,
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
      <Markers
        editor={editor}
        wrap={wrap}
        others={others ?? []}
        threads={threads ?? {}}
        counts={countThreads}
        onOpenThread={onOpenThread}
        pointed={selecting ? undefined : pointed}
        onAddThread={actions.comment}
      />
      <Highlights
        editor={editor}
        open={wordThreads ?? []}
        lit={litThread}
        active={activeThread}
        onShow={onShowThread}
        onLight={onLightThread}
      />
      <ChipPicker kind={picking} onClose={() => setPicking(null)} onPick={insertChip} />
    </div>
  );
}
