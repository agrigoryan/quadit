// What this product adds to the editor's own menus: people and agents
// after "@", a task chip and a page link in the slash menu, and "Comment"
// in the formatting toolbar and the block's drag-handle menu.

import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  type DefaultReactSuggestionItem,
  DragHandleMenu,
  RemoveBlockItem,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from "@blocknote/react";
import { FileSymlink, ListTodo, MessageSquarePlus } from "lucide-react";
import { createContext, useContext } from "react";
import { t } from "@/lib/i18n";
import { getState } from "@/lib/store";
import type { AnyEditor } from "@/docs/editor/sync";
import { Avatar } from "@/ui/avatar";

/** What the menus can ask the page to do. */
export interface EditorActions {
  comment: (blockId: string) => void;
  pickTask: () => void;
  pickPage: () => void;
}

export const ActionsContext = createContext<EditorActions | null>(null);

/** People first, then agents: whoever can be mentioned. */
export function mentionItems(editor: AnyEditor): DefaultReactSuggestionItem[] {
  const members = Object.values(getState().c.members)
    .filter((m) => !m.removed_at && !m.suspended_at)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "person" ? -1 : 1));
  return members.map((m) => ({
    title: m.name,
    subtext: `@${m.handle}`,
    aliases: [m.handle],
    group: t(m.kind === "agent" ? "docs.mention.agents" : "docs.mention.people"),
    icon: <Avatar member={m} size="sm" />,
    size: "small" as const,
    onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { handle: m.handle } }, " "] as never),
  }));
}

/** Slash-menu entries for the two inline things that need a pick first. */
export function extraSlashItems(actions: EditorActions): DefaultReactSuggestionItem[] {
  return [
    {
      title: t("docs.slash.task"),
      subtext: t("docs.slash.taskHint"),
      aliases: ["task", "issue", "ticket"],
      group: t("docs.slash.group"),
      icon: <ListTodo size={18} />,
      onItemClick: actions.pickTask,
    },
    {
      title: t("docs.slash.page"),
      subtext: t("docs.slash.pageHint"),
      aliases: ["page", "link", "doc"],
      group: t("docs.slash.group"),
      icon: <FileSymlink size={18} />,
      onItemClick: actions.pickPage,
    },
  ];
}

/** "Comment" in the toolbar that floats over a selection: on the block the selection starts in. */
export function CommentButton() {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  const actions = useContext(ActionsContext);
  if (!Components || !actions) return null;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label={t("docs.comment.add")}
      mainTooltip={t("docs.comment.add")}
      icon={<MessageSquarePlus size={16} />}
      onClick={() => actions.comment(editor.getTextCursorPosition().block.id)}
    />
  );
}

function CommentItem() {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  const actions = useContext(ActionsContext);
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (!Components || !actions || !block) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => actions.comment(block.id)}>
      {t("docs.comment.add")}
    </Components.Generic.Menu.Item>
  );
}

/** The menu behind a block's drag handle: the editor's own entries, and "Comment". */
export function BlockMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      <CommentItem />
    </DragHandleMenu>
  );
}
