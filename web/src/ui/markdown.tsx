import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { useTaskLink } from "@/lib/task-link";

// Markdown as the server stores it, with two additions shown as links:
// @handle of a real member, and a task key such as SVA-12.

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const refPattern = /(^|[^A-Za-z0-9_@/])(@[a-z0-9][a-z0-9_-]{1,31}|[A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** Splits a text node around mentions and task keys. */
function splitText(value: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  // Only a key of a project there is: "UTF-8" and "SHA-256" are words.
  const projects = new Set(Object.values(useStore.getState().c.projects).map((p) => p.key));
  for (const m of value.matchAll(refPattern)) {
    const ref = m[2] as string;
    if (!ref.startsWith("@") && !projects.has(ref.slice(0, ref.lastIndexOf("-")))) continue;
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
  url.startsWith("mention:") || url.startsWith("task:") ? url : defaultUrlTransform(url);

/** A task's key in a text opens the task the way every link to a task does. */
function TaskRef({ taskKey, children }: { taskKey: string; children?: React.ReactNode }) {
  return (
    <Link {...useTaskLink({ key: taskKey })} className="task-ref">
      {children}
    </Link>
  );
}

function RefLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const handle = href?.startsWith("mention:") ? href.slice(8) : undefined;
  const member = useStore((s) => (handle ? Object.values(s.c.members).find((m) => m.handle === handle) : undefined));
  const meId = useStore((s) => s.me?.user_id);
  if (handle) {
    if (!member) return <>{children}</>;
    return (
      <span className={cx("mention", member.user_id === meId && "is-me")} title={member.name}>
        {children}
      </span>
    );
  }
  if (href?.startsWith("task:")) return <TaskRef taskKey={href.slice(5)}>{children}</TaskRef>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

interface Props {
  text: string;
  /** Smaller type, for comments and cards. */
  tight?: boolean;
  className?: string;
}

export const Markdown = memo(function Markdown({ text, tight, className }: Props) {
  return (
    <div className={cx("md", tight && "md-tight", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRefs]} urlTransform={allowRefs} components={{ a: RefLink }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
