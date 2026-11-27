import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useId,
  useRef,
  useState,
} from "react";
import { cx } from "@/lib/cx";
import { pageLink } from "@/lib/page-refs";
import { useMembers, useRows } from "@/data/selectors";
import type { Member } from "@/types/core";
import type { Doc } from "@/types/docs";
import { useListening } from "@/data/listening";
import { sendOnModEnter } from "@/lib/mod-enter";
import { Avatar } from "@/ui/avatar";
import { Textarea } from "@/ui/input";
import { ListeningDot } from "@/ui/listening-dot";
import { markdownKey } from "@/ui/markdown-keys";
import { docTitle, PageIcon } from "@/ui/page-name";

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl-Enter. */
  onSubmit?: () => void;
  /** Files pasted or dropped into the text. */
  onFiles?: (files: File[]) => void;
  /** The project the text is written in: its pages are offered first after [[. */
  projectId?: string;
  bare?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** What is being typed just before the caret that the box offers to finish: "@par", a member; "[[par", a page. */
interface Typing {
  kind: "member" | "page";
  /** Where what is typed starts, its @ or [[ included: picking replaces it from there. */
  start: number;
  /** What follows the @ or the [[, in lower case. */
  query: string;
}

function typingAt(text: string, caret: number): Typing | null {
  const before = text.slice(0, caret);
  const member = /(^|[\s(])@([a-z0-9_-]*)$/i.exec(before);
  if (member) {
    const query = member[2] ?? "";
    return { kind: "member", start: caret - query.length - 1, query: query.toLowerCase() };
  }
  const page = /\[\[([^[\]\n]*)$/.exec(before);
  return page ? { kind: "page", start: page.index, query: (page[1] ?? "").toLowerCase() } : null;
}

/** One thing offered: what picking it writes, and how it shows in the list. */
interface Offer {
  id: string;
  insert: string;
  view: ReactNode;
}

/** How many things the list offers at once: typing more narrows it. */
const OFFERED = 6;

/**
 * The pages whose title holds what is typed: those of the project first,
 * then the latest changed. A database's rows are left out, as when a page
 * is linked to a task.
 */
function pagesFor(docs: Doc[], query: string, projectId: string | undefined): Doc[] {
  return docs
    .filter((d) => d.kind !== "row" && docTitle(d).toLowerCase().includes(query))
    .sort(
      (a, b) => Number(b.project_id === projectId) - Number(a.project_id === projectId) || b.updated_at - a.updated_at,
    )
    .slice(0, OFFERED);
}

/**
 * A growing text box for Markdown. Typing @ offers the people and agents of
 * the workspace, and typing [[ the pages by title, to be written as a link
 * to the page ([Title](doc:ID)); arrows move, Enter or Tab picks. Cmd+B,
 * Cmd+I and Enter on a list item help write Markdown (ui/markdown-keys.ts).
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
  const members = useMembers();
  const docs = useRows("docs");
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();

  let offers: Offer[] = [];
  if (typing?.kind === "member") {
    const query = typing.query;
    offers = members
      .filter((m) => m.handle.startsWith(query) || m.name.toLowerCase().includes(query))
      .slice(0, OFFERED)
      .map((m) => ({ id: m.user_id, insert: `@${m.handle} `, view: <MemberOffer member={m} /> }));
  } else if (typing?.kind === "page") {
    offers = pagesFor(docs, typing.query, projectId).map((d) => ({
      id: d.id,
      insert: pageLink(docTitle(d), d.id),
      view: <PageOffer doc={d} />,
    }));
  }
  const open = offers.length > 0;

  function track(el: HTMLTextAreaElement) {
    setTyping(typingAt(el.value, el.selectionStart));
    setActive(0);
  }

  function pick(offer: Offer) {
    const el = box.current;
    if (!el || !typing) return;
    const caret = el.selectionStart;
    onChange(value.slice(0, typing.start) + offer.insert + value.slice(caret));
    setTyping(null);
    const at = typing.start + offer.insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : offers.length - 1)) % offers.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(offers[active] as Offer);
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
      {open && <Offers id={listId} offers={offers} active={active} onActive={setActive} onPick={pick} />}
    </div>
  );
}

interface OffersProps {
  id: string;
  offers: Offer[];
  active: number;
  onActive: (index: number) => void;
  onPick: (offer: Offer) => void;
}

/** The list of what the box offers, driven from the text box's keys. */
function Offers({ id, offers, active, onActive, onPick }: OffersProps) {
  return (
    <ul
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- a list the text box drives with its arrows (aria-activedescendant); a <select> cannot be
      role="listbox"
      className="absolute top-full left-0 z-[65] mt-1 w-60 rounded-lg bg-surface p-1 shadow-pop animate-pop"
      onMouseDown={(e) => e.preventDefault()}
    >
      {offers.map((offer, i) => (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the text box's keys pick from the list
        <li
          key={offer.id}
          id={`${id}-${i}`}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- see the list
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => onActive(i)}
          onClick={() => onPick(offer)}
          className={cx(
            "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm",
            i === active && "bg-hover",
          )}
        >
          {offer.view}
        </li>
      ))}
    </ul>
  );
}

/** A person or an agent an "@" offers; beside an agent, whether anything is listening for its work right now. */
function MemberOffer({ member }: { member: Member }) {
  const on = useListening()(member);
  return (
    <>
      <Avatar member={member} size="sm" />
      <span className="min-w-0 flex-1 truncate">{member.name}</span>
      <span className="text-xs text-ink-3">@{member.handle}</span>
      {on !== undefined && <ListeningDot on={on} />}
    </>
  );
}

/** A page a "[[" offers. */
function PageOffer({ doc }: { doc: Doc }) {
  return (
    <>
      <PageIcon doc={doc} />
      <span className="min-w-0 flex-1 truncate">{docTitle(doc)}</span>
    </>
  );
}
