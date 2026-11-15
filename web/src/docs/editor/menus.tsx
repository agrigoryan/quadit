// What this product adds to the editor's own menus: people and agents
// after "@", decisions after "#", page titles after "[[", a task chip, a
// decision and a page link in the slash menu, and "Comment" in the
// formatting toolbar and the block's drag-handle menu.

import { SideMenuExtension, SuggestionMenu } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  type DefaultReactSuggestionItem,
  DragHandleMenu,
  RemoveBlockItem,
  type SuggestionMenuProps,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from "@blocknote/react";
import { CircleHelp, FileSymlink, ListTodo, MessageSquarePlus } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { t } from "@/lib/i18n";
import { getState } from "@/lib/store";
import { decisionStateText } from "@/docs/editor/chips";
import { canSee, docTitle, pathTo } from "@/docs/data";
import { mentionable } from "@/docs/editor/decision-refs";
import type { AnyEditor } from "@/docs/editor/sync";
import { PageIcon } from "@/docs/page-icon";
import type { Doc } from "@/docs/types";
import { Avatar } from "@/ui/avatar";
import { DecisionMark } from "@/ui/icons";

/** What the menus can ask the page to do. */
export interface EditorActions {
  comment: (blockId: string) => void;
  pickTask: () => void;
  pickDecision: () => void;
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

/** The most a menu that opens while typing lists at once. */
const MENU_MAX = 12;
const KEY_BEFORE = /(?:^|[\s(])([A-Z][A-Z0-9]{1,9}-\d{1,6})$/;

/** The text of the caret's block just before the caret, one character per position. */
function textBefore(editor: AnyEditor, reach: number): string {
  const $from = editor.prosemirrorState.selection.$from;
  return $from.parent.textBetween(Math.max(0, $from.parentOffset - reach), $from.parentOffset, undefined, "\uFFFC");
}

/** The task key typed right before the "#" that opened the menu: "SVA-12#" asks for that task's decisions. */
function keyBeforeHash(editor: AnyEditor, query: string): string | undefined {
  const before = textBefore(editor, query.length + 20);
  const upTo = before.length - query.length - 1;
  if (upTo < 0 || before[upTo] !== "#") return undefined;
  return KEY_BEFORE.exec(before.slice(0, upTo))?.[1];
}

/** "#" opens the decisions only where it can name one: after a space or a task's key, not where it starts a heading. */
export function hashOpensDecisions(editor: AnyEditor): boolean {
  const before = textBefore(editor, 20);
  return /[\s(]$/.test(before) || KEY_BEFORE.test(before);
}

/** Two entries of a menu may not read the same: the later ones say what tells them apart. */
function distinct<T extends DefaultReactSuggestionItem>(items: T[], more: (item: T, i: number) => string): T[] {
  const seen = new Set<string>();
  return items.map((item, i) => {
    let title = item.title;
    if (seen.has(title)) title = `${title} (${more(item, i)})`;
    for (let n = 2; seen.has(title); n++) title = `${item.title} (${more(item, i)}, ${n})`;
    seen.add(title);
    return title === item.title ? item : { ...item, title };
  });
}

/** Decisions after "#": found by the question, the task's key, or "SVA-12#2"; after a task's key, that task's own. */
export function decisionItems(editor: AnyEditor, query: string): DefaultReactSuggestionItem[] {
  // A space right after "#" is a heading or a plain hash, not a search.
  if (/^\s/.test(query)) return [];
  const { c } = getState();
  const key = keyBeforeHash(editor, query);
  const q = query.trim().toLowerCase();
  let found = mentionable(c);
  if (key) found = found.filter((f) => f.task.key === key).sort((a, b) => (a.ref.length - b.ref.length) || (a.ref < b.ref ? -1 : 1));
  if (q) {
    found = found.filter(
      (f) =>
        f.decision.question.toLowerCase().includes(q) ||
        f.ref.toLowerCase().includes(q) ||
        (key && f.ref.slice(f.ref.indexOf("#") + 1).startsWith(q)) ||
        f.task.title.toLowerCase().includes(q),
    );
  }
  const refs = found.slice(0, MENU_MAX).map((f) => f.ref);
  const items = found.slice(0, MENU_MAX).map((f) => ({
    title: f.decision.question,
    subtext: `${f.task.key} · ${decisionStateText(f.decision)}`,
    group: t("docs.mention.decisions"),
    icon: <DecisionMark mine={f.decision.state === "open" && f.decision.asked_id === getState().me?.user_id} />,
    onItemClick: () => {
      // "SVA-12#" was typed as text: the chip takes the key's place too.
      const sel = editor.prosemirrorState.selection;
      const before = textBefore(editor, 20);
      if (KEY_BEFORE.exec(before)?.[1] === f.task.key) editor.transact((tr) => tr.delete(sel.from - f.task.key.length, sel.from));
      editor.insertInlineContent([{ type: "decisionChip", props: { key: f.ref } }, " "] as never);
    },
  }));
  return distinct(items, (_item, i) => refs[i] as string);
}

/** Page titles after "[[": picking one puts a link to that page; typing a title out and closing the brackets does the same. */
export function pageTitleItems(editor: AnyEditor, query: string, self?: string): DefaultReactSuggestionItem[] {
  // Still typing inside the brackets: what follows a closing bracket is not part of a title.
  if (query.includes("]") || query.includes("\uFFFC")) return [];
  const { c, me } = getState();
  const docs = c.docs as unknown as Record<string, Doc>;
  const q = query.trim().toLowerCase();
  const pages = Object.values(docs)
    .filter((d) => d.id !== self && !d.deleted_at && !d.archived_at && d.kind !== "row" && (!me || canSee(d, me.user_id)) && !!d.title.trim())
    .filter((d) => !q || d.title.toLowerCase().includes(q))
    // Titles that start with what was typed come first.
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)) || a.title.localeCompare(b.title))
    .slice(0, MENU_MAX);
  const items = pages.map((doc) => ({
    title: docTitle(doc),
    subtext: pathTo(docs, doc.id).map((d) => docTitle(d)).join(" / ") || undefined,
    group: t("docs.mention.pages"),
    icon: <PageIcon doc={doc} />,
    size: "small" as const,
    onItemClick: () => editor.insertInlineContent([{ type: "pageLink", props: { doc: doc.id } }, " "] as never),
  }));
  return distinct(items, (item, i) => item.subtext ?? String(i + 1));
}

/** A menu that opens while typing and says nothing when there is nothing to offer, so "#" and "[[" stay ordinary text. */
export function QuietMenu({ items, loadingState, selectedIndex, onItemClick }: SuggestionMenuProps<DefaultReactSuggestionItem>) {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  // An open menu takes Enter and the arrow keys; one with nothing in it must not, so it closes.
  const nothing = loadingState === "loaded" && items.length === 0;
  useEffect(() => {
    if (nothing) editor.getExtension(SuggestionMenu)?.closeMenu();
  }, [nothing, editor]);
  if (!Components || items.length === 0) return null;
  const out: ReactNode[] = [];
  let group: string | undefined;
  items.forEach((item, i) => {
    if (item.group !== group) {
      group = item.group;
      out.push(
        <Components.SuggestionMenu.Label className="bn-suggestion-menu-label" key={`group:${group}`}>
          {group}
        </Components.SuggestionMenu.Label>,
      );
    }
    out.push(
      <Components.SuggestionMenu.Item
        className={item.size === "small" ? "bn-suggestion-menu-item bn-suggestion-menu-item-small" : "bn-suggestion-menu-item"}
        item={item}
        id={`bn-suggestion-menu-item-${i}`}
        isSelected={i === selectedIndex}
        key={item.title}
        onClick={() => onItemClick?.(item)}
      />,
    );
  });
  return (
    <Components.SuggestionMenu.Root id="bn-suggestion-menu" className="bn-suggestion-menu qd-quiet-menu">
      {out}
    </Components.SuggestionMenu.Root>
  );
}

/** Slash-menu entries for the inline things that need a pick first. */
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
      title: t("docs.slash.decision"),
      subtext: t("docs.slash.decisionHint"),
      aliases: ["decision", "question", "choice", "approval"],
      group: t("docs.slash.group"),
      icon: <CircleHelp size={18} />,
      onItemClick: actions.pickDecision,
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
