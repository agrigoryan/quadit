import { type KeyboardEvent, type Ref, type TextareaHTMLAttributes, useId, useRef, useState } from "react";
import { Popover as RPopover } from "radix-ui";
import { sendOnModEnter } from "@/lib/mod-enter";
import { Textarea } from "@/ui/input";
import { markdownKey, typeText } from "@/ui/markdown-keys";
import { type Asked, type MenuRow, MentionOptions, type SectionName, useMentionMenu } from "@/ui/mention-menu";

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl-Enter. */
  onSubmit?: () => void;
  /** Files pasted or dropped into the text. */
  onFiles?: (files: File[]) => void;
  /**
   * The project the text is written in: its tasks and pages are offered
   * first, and its pages are written with their titles (ui/mention-menu.tsx).
   */
  projectId?: string;
  bare?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** What is being typed just before the caret that the box offers to finish: "@par", someone or something; "[[par", a page. */
interface Typing extends Asked {
  /** Where what is typed starts, its @ or [[ included: picking replaces it from there. */
  start: number;
}

function typingAt(text: string, caret: number): Typing | null {
  const before = text.slice(0, caret);
  const mention = /(^|[\s(])@([a-z0-9_-]*)$/i.exec(before);
  if (mention) {
    const query = mention[2] ?? "";
    return { kind: "mention", start: caret - query.length - 1, query: query.toLowerCase() };
  }
  const page = /\[\[([^[\]\n]*)$/.exec(before);
  return page ? { kind: "page", start: page.index, query: (page[1] ?? "").toLowerCase() } : null;
}

/**
 * Starts a mention at the cursor of a MentionTextarea, as typing "@" would,
 * so the box offers whom or what to mention: for a button beside the box. A space
 * goes first where the "@" would stick to a word.
 */
export function startMention(box: HTMLTextAreaElement) {
  box.focus();
  const before = box.value.slice(0, box.selectionStart);
  typeText(box, box.selectionStart, box.selectionEnd, before === "" || /[\s(]$/.test(before) ? "@" : " @");
}

/**
 * A growing text box for Markdown. Typing @ offers the people and agents of
 * the workspace, the tasks and the pages, each under its heading (written
 * as @handle, as the task's key, and as a link to the page); typing [[
 * offers the pages alone (ui/mention-menu.tsx). Arrows move across the
 * list, Enter or Tab picks. Cmd+B, Cmd+I and Enter on a list item help
 * write Markdown (ui/markdown-keys.ts). What is picked is typed in, so the
 * box's own undo takes it back.
 */
export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  onFiles,
  projectId,
  className,
  bare,
  ref,
  onKeyDown,
  ...rest
}: Props) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  // The section whose "more" row was picked; another "@" shows every section again.
  const [expanded, setExpanded] = useState<SectionName | null>(null);
  const listId = useId();

  // Worked out again as what is typed changes, not as the arrows move (track keeps `typing` while it is the same).
  const sections = useMentionMenu(typing, projectId, expanded);
  const rows = sections.flatMap((s) => s.rows);
  const open = rows.length > 0;
  // The list can grow shorter under the highlight (a page renamed or trashed meanwhile).
  const current = Math.min(active, rows.length - 1);

  function track(el: HTMLTextAreaElement) {
    const now = typingAt(el.value, el.selectionStart);
    if (now?.kind === typing?.kind && now?.start === typing?.start && now?.query === typing?.query) return;
    if (now?.start !== typing?.start) setExpanded(null);
    setTyping(now);
    setActive(0);
  }

  /**
   * Writes what is picked in place of what was typed for it, as typing
   * would, so that undo takes it back. A section's "more" row shows the
   * rest of the section instead, highlighting the first row it adds.
   */
  function pick(row: MenuRow) {
    if ("more" in row) {
      setExpanded(row.more);
      setActive(sections.find((s) => s.name === row.more)?.rows.indexOf(row) ?? 0);
      return;
    }
    const el = box.current;
    const now = el && typingAt(el.value, el.selectionStart);
    setTyping(null);
    if (!el || !now || now.start !== typing?.start) return;
    typeText(el, now.start, el.selectionStart, row.insert);
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // An input method that is composing has the keys.
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (Math.min(i, rows.length - 1) + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(rows[current] as MenuRow);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setTyping(null);
        return;
      }
    }
    if (onSubmit && sendOnModEnter(e, onSubmit)) return;
    if (markdownKey(e)) return;
    onKeyDown?.(e);
  }

  return (
    // The list is placed by the box and drawn above everything else, so a scrolling panel or a dialog does not cut it off.
    <RPopover.Root open={open}>
      <RPopover.Anchor asChild>
        <div className="relative">
          <Textarea
            ref={(el) => {
              box.current = el;
              if (typeof ref === "function") ref(el);
              else if (ref) ref.current = el;
            }}
            value={value}
            autoGrow
            bare={bare}
            className={className}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${current}` : undefined}
            onChange={(e) => {
              onChange(e.target.value);
              track(e.target);
            }}
            onKeyDown={keyDown}
            onSelect={(e) => track(e.currentTarget)}
            onBlur={() => setTyping(null)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length && onFiles) {
                e.preventDefault();
                onFiles(files);
              }
            }}
            {...rest}
          />
        </div>
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          id={listId}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a list the text box drives with its arrows (aria-activedescendant); a <select> cannot be
          role="listbox"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // The text box keeps the focus and the keys; what closes the list is the box's (its keys, the caret, a blur).
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          className="z-[60] max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg bg-surface p-1 text-ink shadow-pop outline-none animate-pop"
        >
          <MentionOptions id={listId} sections={sections} active={current} onActive={setActive} onPick={pick} />
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
