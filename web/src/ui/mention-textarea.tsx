import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "@/lib/cx";
import { pageLink } from "@/lib/page-refs";
import { canSeePage } from "@/data/access";
import { useMe, useMembers, useRows } from "@/data/selectors";
import type { Member } from "@/types/core";
import type { Doc } from "@/types/docs";
import { useListening } from "@/data/listening";
import { sendOnModEnter } from "@/lib/mod-enter";
import { Avatar } from "@/ui/avatar";
import { Textarea } from "@/ui/input";
import { ListeningDot } from "@/ui/listening-dot";
import { markdownKey, typeText } from "@/ui/markdown-keys";
import { docTitle, PageIcon } from "@/ui/page-name";

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl-Enter. */
  onSubmit?: () => void;
  /** Files pasted or dropped into the text. */
  onFiles?: (files: File[]) => void;
  /**
   * The project the text is written in: its pages are offered first after
   * [[, and are written with their titles (see pageWritten).
   */
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
 * The first pages the writer may see whose title holds what is typed: those
 * of the project first, then the latest changed. A database's rows are left
 * out, as when a page is linked to a task. Only the first few are kept in
 * order, whatever the number of pages.
 */
function pagesFor(docs: Doc[], query: string, projectId: string | undefined, userId: string): Doc[] {
  const before = (a: Doc, b: Doc) =>
    Number(b.project_id === projectId) - Number(a.project_id === projectId) || b.updated_at - a.updated_at;
  const first: Doc[] = [];
  for (const d of docs) {
    if (d.kind === "row" || !docTitle(d).toLowerCase().includes(query) || !canSeePage(d, userId)) continue;
    const at = first.findIndex((kept) => before(d, kept) < 0);
    first.splice(at < 0 ? first.length : at, 0, d);
    if (first.length > OFFERED) first.pop();
  }
  return first;
}

/**
 * What picking a page writes. Its title goes into the text only where
 * everyone who may read the text may see the page too: a page of the
 * project the text is in, or the workspace's own page that is not private.
 * Any other is written by its id alone, which a reader who may see the page
 * sees by its title, and one who may not sees as the id.
 */
function pageWritten(doc: Doc, projectId: string | undefined): string {
  const everyReader = !doc.owner_id && (!doc.project_id || doc.project_id === projectId);
  return everyReader ? pageLink(docTitle(doc), doc.id) : `doc:${doc.id}`;
}

/**
 * A growing text box for Markdown. Typing @ offers the people and agents of
 * the workspace, and typing [[ the pages by title, to be written as a link
 * to the page ([Title](doc:ID)); arrows move, Enter or Tab picks. Cmd+B,
 * Cmd+I and Enter on a list item help write Markdown (ui/markdown-keys.ts).
 * What is picked is typed in, so the box's own undo takes it back.
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
  const me = useMe();
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();

  // Worked out again as what is typed changes, not as the arrows move (track keeps `typing` while it is the same).
  const offers: Offer[] = useMemo(() => {
    if (typing?.kind === "member") {
      const query = typing.query;
      return members
        .filter((m) => m.handle.startsWith(query) || m.name.toLowerCase().includes(query))
        .slice(0, OFFERED)
        .map((m) => ({ id: m.user_id, insert: `@${m.handle} `, view: <MemberOffer member={m} /> }));
    }
    if (typing?.kind === "page") {
      return pagesFor(docs, typing.query, projectId, me.user_id).map((d) => ({
        id: d.id,
        insert: pageWritten(d, projectId),
        view: <PageOffer doc={d} />,
      }));
    }
    return [];
  }, [typing, members, docs, projectId, me.user_id]);
  const open = offers.length > 0;
  // The list can grow shorter under the highlight (a page renamed or trashed meanwhile).
  const current = Math.min(active, offers.length - 1);

  function track(el: HTMLTextAreaElement) {
    const now = typingAt(el.value, el.selectionStart);
    if (now?.kind === typing?.kind && now?.start === typing?.start && now?.query === typing?.query) return;
    setTyping(now);
    setActive(0);
  }

  /** Writes what is picked in place of what was typed for it, as typing would, so that undo takes it back. */
  function pick(offer: Offer) {
    const el = box.current;
    const now = el && typingAt(el.value, el.selectionStart);
    setTyping(null);
    if (!el || !now || now.start !== typing?.start) return;
    typeText(el, now.start, el.selectionStart, offer.insert);
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // An input method that is composing has the keys.
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : offers.length - 1)) % offers.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(offers[current] as Offer);
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
      {open && <Offers id={listId} offers={offers} active={current} onActive={setActive} onPick={pick} />}
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
