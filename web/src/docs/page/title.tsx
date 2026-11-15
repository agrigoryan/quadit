import { SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePausedWrite } from "@/hooks/paused-write";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { updateDoc } from "@/docs/actions";
import { docTitle } from "@/docs/data";
import { AddCoverButton } from "@/docs/page/cover";
import { PageIcon } from "@/docs/page-icon";
import { IconPicker } from "@/docs/tree/icon-picker";
import type { Doc } from "@/types/docs";
import { Textarea } from "@/ui/input";

interface Props {
  doc: Doc;
  readOnly?: boolean;
  compact?: boolean;
  /** Enter in the title: go on to the page's text. */
  onEnter?: () => void;
}

const ADD =
  "flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-60";

/** A page's icon and title, edited in place. */
export function PageTitle({ doc, readOnly, compact, onEnter }: Props) {
  const [value, setValue] = useState(doc.title);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const save = usePausedWrite(500);

  // Someone else renamed the page: show it, unless the person is typing here.
  useEffect(() => {
    if (!focused) setValue(doc.title);
  }, [doc.title, focused]);

  // A page just made starts in its title.
  useEffect(() => {
    if (!readOnly && !doc.title && Date.now() - doc.created_at < 4000) box.current?.focus();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when another page opens, not when its title changes
  }, [doc.id]);

  // The title's type, the same whether it can be edited or not.
  const type = cx(
    "font-bold tracking-tight",
    compact ? "text-xl leading-7" : "text-[1.75rem] leading-9 sm:text-[2rem] sm:leading-10",
  );

  return (
    <div className={cx("group/title", compact ? "pt-2" : doc.cover ? "pt-5" : "pt-8 sm:pt-12")}>
      {!readOnly && doc.icon && (
        <IconPicker docId={doc.id} current={doc.icon}>
          <button
            type="button"
            aria-label={t("docs.icon.change")}
            className={cx(
              "-ml-1 mb-1 flex items-center justify-center rounded-md hover:bg-hover",
              compact ? "size-9 [&>*]:size-6 [&>*]:text-2xl" : "size-12 [&>*]:size-9 [&>*]:text-4xl",
            )}
          >
            <PageIcon doc={doc} />
          </button>
        </IconPicker>
      )}
      {!readOnly && (!doc.icon || (!doc.cover && !compact)) && (
        // What the page could still have; quiet until the pointer is near the title.
        <div className="-ml-1.5 mb-1 flex flex-wrap gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/title:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
          {!doc.icon && (
            <IconPicker docId={doc.id} current={doc.icon}>
              <button type="button" className={ADD}>
                <SmilePlus className="size-3.5" />
                {t("docs.icon.add")}
              </button>
            </IconPicker>
          )}
          {!doc.cover && !compact && <AddCoverButton docId={doc.id} className={ADD} />}
        </div>
      )}
      {readOnly && doc.icon && (
        <div className="mb-1 flex size-12 items-center [&>*]:size-9 [&>*]:text-4xl">
          <PageIcon doc={doc} />
        </div>
      )}
      {readOnly ? (
        // Someone who may not edit the page reads its title as words, not as a box to Tab into.
        <h1 className={cx(type, "break-words", !doc.title.trim() && "text-ink-3/70")}>{docTitle(doc)}</h1>
      ) : (
        <Textarea
          ref={box}
          bare
          autoGrow
          rows={1}
          value={value}
          aria-label={t("docs.title.label")}
          placeholder={t("docs.untitled")}
          className={cx(type, "placeholder:text-ink-3/70")}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            save.flush();
          }}
          onChange={(e) => {
            const next = e.target.value.replace(/\n/g, " ");
            setValue(next);
            save.hold(() => updateDoc(doc.id, { title: next.trim() }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              onEnter?.();
            }
          }}
        />
      )}
    </div>
  );
}
