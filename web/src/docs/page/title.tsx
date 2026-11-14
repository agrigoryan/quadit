import { SmilePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { updateDoc } from "@/docs/actions";
import { PageIcon } from "@/docs/page-icon";
import { IconPicker } from "@/docs/tree/icon-picker";
import type { Doc } from "@/docs/types";
import { Textarea } from "@/ui/input";

interface Props {
  doc: Doc;
  readOnly?: boolean;
  compact?: boolean;
  /** Enter in the title: go on to the page's text. */
  onEnter?: () => void;
}

/** A page's icon and title, edited in place. */
export function PageTitle({ doc, readOnly, compact, onEnter }: Props) {
  const [value, setValue] = useState(doc.title);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Someone else renamed the page: show it, unless the person is typing here.
  useEffect(() => {
    if (!focused) setValue(doc.title);
  }, [doc.title, focused]);

  // A page just made starts in its title.
  useEffect(() => {
    if (!readOnly && !doc.title && Date.now() - doc.created_at < 4000) box.current?.focus();
  }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (title: string) => {
    clearTimeout(timer.current);
    updateDoc(doc.id, { title: title.trim() });
  };

  return (
    <div className={cx("group/title", compact ? "pt-2" : "pt-8 sm:pt-12")}>
      {!readOnly && (
        <IconPicker docId={doc.id} current={doc.icon}>
          {doc.icon ? (
            <button type="button" aria-label={t("docs.icon.change")} className={cx("-ml-1 mb-1 flex items-center justify-center rounded-md hover:bg-hover", compact ? "size-9 [&>*]:size-6 [&>*]:text-2xl" : "size-12 [&>*]:size-9 [&>*]:text-4xl")}>
              <PageIcon doc={doc} />
            </button>
          ) : (
            <button
              type="button"
              className="-ml-1.5 mb-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/title:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
            >
              <SmilePlus className="size-3.5" />
              {t("docs.icon.add")}
            </button>
          )}
        </IconPicker>
      )}
      {readOnly && doc.icon && (
        <div className="mb-1 flex size-12 items-center [&>*]:size-9 [&>*]:text-4xl">
          <PageIcon doc={doc} />
        </div>
      )}
      <Textarea
        ref={box}
        bare
        autoGrow
        rows={1}
        readOnly={readOnly}
        value={value}
        aria-label={t("docs.title.label")}
        placeholder={t("docs.untitled")}
        className={cx("font-bold tracking-tight placeholder:text-ink-3/70", compact ? "text-xl leading-7" : "text-[1.75rem] leading-9 sm:text-[2rem] sm:leading-10")}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          save(value);
        }}
        onChange={(e) => {
          const next = e.target.value.replace(/\n/g, " ");
          setValue(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => save(next), 500);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "ArrowDown") {
            e.preventDefault();
            onEnter?.();
          }
        }}
      />
    </div>
  );
}
