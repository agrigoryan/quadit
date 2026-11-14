// Plain text that names something becomes the live chip for it when a page
// is shown: "@artist", "SVA-12", "doc:<id>". Pages written as Markdown (by
// agents, by import) carry these as text; the server reads them the same
// either way, so nothing is lost by showing the chip.

import { findTaskByKey } from "@/lib/selectors";
import { getState } from "@/lib/store";

const REF = /(^|[\s(])(?:@([a-z0-9][a-z0-9_-]*)|([A-Z][A-Z0-9]{1,9}-\d{1,6})|doc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))(?![\w-])/g;

type Styles = Record<string, unknown>;

/** Splits a run of text around the things it names. Text that names nothing known comes back whole. */
export function chipify(text: string, styles: Styles): unknown[] {
  if (styles.code || !/[@-]|doc:/.test(text)) return [{ type: "text", text, styles }];
  const { c } = getState();
  const out: unknown[] = [];
  let last = 0;
  const push = (upTo: number) => {
    if (upTo > last) out.push({ type: "text", text: text.slice(last, upTo), styles });
  };
  for (const m of text.matchAll(REF)) {
    const start = m.index + (m[1] ?? "").length;
    let chip: unknown;
    if (m[2]) {
      const handle = m[2];
      if (Object.values(c.members).some((mem) => mem.handle === handle)) chip = { type: "mention", props: { handle } };
    } else if (m[3]) {
      const task = findTaskByKey(c.tasks, m[3]);
      if (task && !task.deleted_at) chip = { type: "taskChip", props: { key: task.key } };
    } else if (m[4] && c.docs[m[4]]) {
      chip = { type: "pageLink", props: { doc: m[4] } };
    }
    if (!chip) continue;
    push(start);
    out.push(chip);
    last = m.index + m[0].length;
  }
  push(text.length);
  return out;
}
