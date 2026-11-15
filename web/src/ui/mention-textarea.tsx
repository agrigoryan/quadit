import { type KeyboardEvent, type Ref, type TextareaHTMLAttributes, useId, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { useMembers } from "@/lib/selectors";
import type { Member } from "@/lib/types";
import { useListening } from "@/lib/listening";
import { sendOnModEnter } from "@/lib/mod-enter";
import { Avatar } from "@/ui/avatar";
import { Textarea } from "@/ui/input";
import { ListeningDot } from "@/ui/listening-dot";

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl-Enter. */
  onSubmit?: () => void;
  /** Files pasted or dropped into the text. */
  onFiles?: (files: File[]) => void;
  bare?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** The "@par" being typed just before the caret, if any. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([a-z0-9_-]*)$/i.exec(text.slice(0, caret));
  return m ? { start: caret - (m[2]?.length ?? 0) - 1, query: (m[2] ?? "").toLowerCase() } : null;
}

/**
 * A growing text box for Markdown. Typing @ offers the people and agents of
 * the workspace; arrows move, Enter or Tab picks.
 */
export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  onFiles,
  className,
  bare,
  ref,
  onKeyDown,
  ...rest
}: Props) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const members = useMembers();
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();

  const options: Member[] = mention
    ? members
        .filter((m) => m.handle.startsWith(mention.query) || m.name.toLowerCase().includes(mention.query))
        .slice(0, 6)
    : [];
  const open = options.length > 0;

  function track(el: HTMLTextAreaElement) {
    setMention(mentionAt(el.value, el.selectionStart));
    setActive(0);
  }

  function pick(member: Member) {
    const el = box.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const insert = `@${member.handle} `;
    onChange(value.slice(0, mention.start) + insert + value.slice(caret));
    setMention(null);
    const at = mention.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(options[active] as Member);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (onSubmit && sendOnModEnter(e, onSubmit)) return;
    onKeyDown?.(e);
  }

  return (
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
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          track(e.target);
        }}
        onKeyDown={keyDown}
        onClick={(e) => track(e.currentTarget)}
        onBlur={() => setMention(null)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length && onFiles) {
            e.preventDefault();
            onFiles(files);
          }
        }}
        {...rest}
      />
      {open && <MentionOptions id={listId} options={options} active={active} onActive={setActive} onPick={pick} />}
    </div>
  );
}

interface OptionsProps {
  id: string;
  options: Member[];
  active: number;
  onActive: (index: number) => void;
  onPick: (member: Member) => void;
}

/** The people and agents an "@" offers. Beside each agent: whether anything is listening for its work right now. */
function MentionOptions({ id, options, active, onActive, onPick }: OptionsProps) {
  const listening = useListening();
  return (
    <ul
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- a list the text box drives with its arrows (aria-activedescendant); a <select> cannot be
      role="listbox"
      className="absolute top-full left-0 z-[65] mt-1 w-60 rounded-lg bg-surface p-1 shadow-pop animate-pop"
      onMouseDown={(e) => e.preventDefault()}
    >
      {options.map((m, i) => {
        const on = listening(m);
        return (
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the text box's keys pick from the list
          <li
            key={m.user_id}
            id={`${id}-${i}`}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- see the list
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => onActive(i)}
            onClick={() => onPick(m)}
            className={cx(
              "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm",
              i === active && "bg-hover",
            )}
          >
            <Avatar member={m} size="sm" />
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            <span className="text-xs text-ink-3">@{m.handle}</span>
            {on !== undefined && <ListeningDot on={on} />}
          </li>
        );
      })}
    </ul>
  );
}
