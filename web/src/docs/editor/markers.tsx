// Small marks beside blocks: who else is in a block (a coloured line with
// their name) and how many open comment threads a block has.

import { MessageSquare } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useLookupEvenIfGone } from "@/lib/selectors";
import { tintOf } from "@/docs/presence-tint";
import type { AnyEditor } from "@/docs/editor/sync";
import type { PresenceEntry } from "@/types/docs";

interface Box {
  top: number;
  height: number;
}

interface Props {
  editor: AnyEditor;
  wrap: RefObject<HTMLDivElement | null>;
  others: PresenceEntry[];
  threads: Record<string, number>;
  onOpenThread?: (blockId: string) => void;
}

export function Markers({ editor, wrap, others, threads, onOpenThread }: Props) {
  const members = useLookupEvenIfGone("members");
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const ids = [...new Set([...others.map((o) => o.block ?? ""), ...Object.keys(threads)])]
    .filter(Boolean)
    .sort()
    .join(" ");

  useEffect(() => {
    const root = wrap.current;
    // Nothing to mark: what was measured before is not looked up, so it can stay.
    if (!root || !ids) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const base = root.getBoundingClientRect();
        const next: Record<string, Box> = {};
        for (const id of ids.split(" ")) {
          const el = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"] .bn-block-content`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          next[id] = { top: r.top - base.top, height: r.height };
        }
        setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      });
    };
    measure();
    const off = editor.onChange(measure);
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      off();
      resize.disconnect();
    };
  }, [editor, wrap, ids]);

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden={others.length === 0 && !onOpenThread}>
      {others.map((o) => {
        const box = o.block ? boxes[o.block] : undefined;
        const member = members[o.user_id];
        if (!box || !member) return null;
        const color = tintOf(o.user_id);
        return (
          <div key={o.user_id} className="qd-presence" style={{ top: box.top, height: box.height, background: color }}>
            <span className="qd-presence-name" style={{ background: color }}>
              {member.name}
            </span>
          </div>
        );
      })}
      {Object.entries(threads).map(([id, count]) => {
        const box = boxes[id];
        if (!box || count === 0) return null;
        return (
          <button
            key={id}
            type="button"
            className="qd-thread-mark pointer-events-auto"
            style={{ top: box.top }}
            aria-label={t("docs.comment.threadsOnBlock", { n: count })}
            onClick={() => onOpenThread?.(id)}
          >
            <MessageSquare className="size-3.5" />
            <span className="tnum">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
