import { type ComponentProps, createContext, memo, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@/lib/cx";
import { pageIdOf, pageRefInText } from "@/lib/page-refs";
import { getProjectByKey, useRows } from "@/data/selectors";
import { useStore } from "@/data/store";
import { MemberMention } from "@/ui/member-mention";
import { PageMention } from "@/ui/page-mention";
import { TaskMention } from "@/ui/task-mention";

// Markdown as the server stores it, with three additions: @handle of a real
// member; a task key such as SVA-12, shown as the task it names
// (ui/task-mention.tsx); and a page, named in any of the ways the server
// reads (lib/page-refs.ts), shown as the page (ui/page-mention.tsx). Where
// the text may be changed, the boxes of a task list ("- [ ] milk") can be
// ticked.

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const refPattern = /(^|[^A-Za-z0-9_@/])(@[a-z0-9][a-z0-9_-]{1,31}|[A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** Splits a text node around pages named in it (doc:ID, [[Title]]), then around mentions and task keys. */
function splitText(value: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of value.matchAll(pageRefInText)) {
    if (m.index > last) out.push(...splitMentions(value.slice(last, m.index)));
    const url = m[1] ? `doc:${m[1]}` : TITLED + encodeURIComponent(m[2] ?? "");
    out.push({ type: "link", url, children: [{ type: "text", value: m[0] }] });
    last = m.index + m[0].length;
  }
  if (last === 0) return splitMentions(value);
  if (last < value.length) out.push(...splitMentions(value.slice(last)));
  return out;
}

/** The address a [[Title]] is given in the tree, its title encoded as the address must be, for RefLink to find the page by. */
const TITLED = "page-titled:";

/** The title a [[Title]]'s address carries; undefined for one written by hand that does not decode. */
function titleOf(href: string): string | undefined {
  try {
    return decodeURIComponent(href.slice(TITLED.length));
  } catch {
    return undefined;
  }
}

/** Splits text around mentions and task keys. */
function splitMentions(value: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of value.matchAll(refPattern)) {
    const ref = m[2] as string;
    // Only a key of a project there is: "UTF-8" and "SHA-256" are words.
    if (!ref.startsWith("@") && !getProjectByKey(ref.slice(0, ref.lastIndexOf("-")))) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    const url = ref.startsWith("@") ? `mention:${ref.slice(1)}` : `task:${ref}`;
    out.push({ type: "link", url, children: [{ type: "text", value: ref }] });
    last = start + ref.length;
  }
  if (last === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: Node) {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return splitText(child.value);
    walk(child);
    return [child];
  });
}

const remarkRefs = () => (tree: Node) => walk(tree);

const allowRefs = (url: string) =>
  ["mention:", "task:", "doc:", TITLED].some((scheme) => url.startsWith(scheme)) ? url : defaultUrlTransform(url);

function RefLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const handle = href?.startsWith("mention:") ? href.slice(8) : undefined;
  const members = useRows("members");
  const member = handle ? members.find((m) => m.handle === handle) : undefined;
  const meId = useStore((s) => s.me?.user_id);
  const card = useContext(MemberMention);
  if (handle) {
    if (!member) return <>{children}</>;
    const className = cx("mention", member.user_id === meId && "is-me");
    if (!card)
      return (
        <span className={className} title={member.name}>
          {children}
        </span>
      );
    return card(
      member,
      <button type="button" className={cx(className, "cursor-pointer")}>
        {children}
      </button>,
    );
  }
  if (href?.startsWith("task:")) return <TaskMention taskKey={href.slice(5)} />;
  if (href?.startsWith(TITLED)) {
    const title = titleOf(href);
    return title === undefined ? <>{children}</> : <PageMention title={title}>{children}</PageMention>;
  }
  const docId = href ? pageIdOf(href) : undefined;
  if (docId) return <PageMention docId={docId}>{children}</PageMention>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** A task list item's start, up to the mark in its box: "- [x", "12. [ ". */
const BOXED_ITEM = /^(?:[-*+]|\d+[.)])\s+\[([ xX])/;

/** The text with the box of the task list item that starts at `offset` ticked, or no longer ticked. */
function flipBox(text: string, offset: number): string {
  const found = BOXED_ITEM.exec(text.slice(offset));
  if (!found) return text;
  const at = offset + found[0].length - 1;
  return text.slice(0, at) + (found[1] === " " ? "x" : " ") + text.slice(at + 1);
}

/** Given, the boxes can be ticked: it flips the box of the item that starts at this offset of the text. */
const Tick = createContext<((offset: number) => void) | null>(null);
/** Where in the text the list item around a box starts. */
const ItemStart = createContext<number | undefined>(undefined);

function ListItem({ node, children, ...rest }: ComponentProps<"li"> & ExtraProps) {
  return (
    <li {...rest}>
      <ItemStart value={node?.position?.start.offset}>{children}</ItemStart>
    </li>
  );
}

function TaskBox({ node: _node, ...rest }: ComponentProps<"input"> & ExtraProps) {
  const tick = useContext(Tick);
  const at = useContext(ItemStart);
  if (rest.type !== "checkbox" || !tick || at === undefined) return <input {...rest} />;
  return <input type="checkbox" checked={!!rest.checked} onChange={() => tick(at)} className="cursor-pointer" />;
}

const components = { a: RefLink, li: ListItem, input: TaskBox };

interface Props {
  text: string;
  /** Smaller type, for comments and cards. */
  tight?: boolean;
  className?: string;
  /** Given, a task list's boxes can be ticked: it is handed the text with the box changed, to save. */
  onTick?: (next: string) => void;
}

export const Markdown = memo(function Markdown({ text, tight, className, onTick }: Props) {
  return (
    <div className={cx("md", tight && "md-tight", className)}>
      <Tick value={onTick ? (offset) => onTick(flipBox(text, offset)) : null}>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkRefs]} urlTransform={allowRefs} components={components}>
          {text}
        </ReactMarkdown>
      </Tick>
    </div>
  );
});
