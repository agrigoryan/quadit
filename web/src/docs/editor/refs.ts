// Plain text that names something becomes the live chip for it when a page
// is shown: "@artist", "SVA-12", a decision as "SVA-12#2", "doc:<id>", and a
// page by its title as "[[Art guide]]" when exactly one page has that title.
// Pages written as Markdown (by agents, by import) carry these as text; the
// server reads them the same either way, so nothing is lost by showing the chip.

import { findTaskByKey } from "@/lib/selectors";
import { type Collections, getState } from "@/lib/store";
import { findDecision } from "@/docs/editor/decision-refs";
import type { Doc } from "@/docs/types";

const REF =
  /(^|[\s(])(?:@([a-z0-9][a-z0-9_-]*)|([A-Z][A-Z0-9]{1,9}-\d{1,6}#\d{1,3})|([A-Z][A-Z0-9]{1,9}-\d{1,6})|doc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))(?![\w-])|\[\[([^[\]\n]{1,200})\]\]/g;

/**
 * The page a title in double brackets names: the one page with exactly that
 * title, as the server reads it. No page, or several, and it stays text.
 */
export function pageByTitle(c: Collections, title: string): Doc | undefined {
  const want = title.trim();
  if (!want) return undefined;
  // The exact title first; then, as the server does, the same title in
  // another case. Several pages either way and it stays text.
  const docs = Object.values(c.docs)
    .map((row) => row as unknown as Doc)
    .filter((doc) => !doc.deleted_at);
  const exact = docs.filter((doc) => doc.title === want);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const lower = want.toLowerCase();
  const loose = docs.filter((doc) => doc.kind !== "row" && (doc.title ?? "").toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

type Styles = Record<string, unknown>;

/** Splits a run of text around the things it names. Text that names nothing known comes back whole. */
export function chipify(text: string, styles: Styles): unknown[] {
  if (styles.code || !/[@-]|doc:|\[\[/.test(text)) return [{ type: "text", text, styles }];
  const { collections: c } = getState();
  const out: unknown[] = [];
  let last = 0;
  const push = (upTo: number) => {
    if (upTo > last) out.push({ type: "text", text: text.slice(last, upTo), styles });
  };
  for (const m of text.matchAll(REF)) {
    const start = m.index + (m[1] ?? "").length;
    let chip: unknown;
    let end = m.index + m[0].length;
    if (m[2]) {
      const handle = m[2];
      if (Object.values(c.members).some((mem) => mem.handle === handle)) chip = { type: "mention", props: { handle } };
    } else if (m[3]) {
      const found = findDecision(c, m[3]);
      if (found) chip = { type: "decisionChip", props: { key: found.ref } };
      else {
        // No such decision (yet): the task it names still gets its chip, and "#2" stays text.
        const key = m[3].slice(0, m[3].indexOf("#"));
        const task = findTaskByKey(c.tasks, key);
        if (task && !task.deleted_at) {
          chip = { type: "taskChip", props: { key: task.key } };
          end = start + key.length;
        }
      }
    } else if (m[4]) {
      const task = findTaskByKey(c.tasks, m[4]);
      if (task && !task.deleted_at) chip = { type: "taskChip", props: { key: task.key } };
    } else if (m[5] && c.docs[m[5]]) {
      chip = { type: "pageLink", props: { doc: m[5] } };
    } else if (m[6]) {
      const doc = pageByTitle(c, m[6]);
      if (doc) chip = { type: "pageLink", props: { doc: doc.id } };
    }
    if (!chip) continue;
    push(start);
    out.push(chip);
    last = end;
  }
  push(text.length);
  return out;
}
