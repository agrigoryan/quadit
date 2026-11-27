// How a page is named wherever it shows: its title, and its mark.

import { Brain, Database, FileText, GitBranch, Sparkles } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Doc } from "@/types/docs";

/** A page's title as shown; one without a title is called Untitled. */
export const docTitle = (doc: Pick<Doc, "title"> | undefined) => doc?.title?.trim() || t("docs.untitled");

/** Names the server gives pages it makes itself, instead of an emoji. */
const NAMED = { git: GitBranch, brain: Brain } as const;

/** A page's mark: its emoji if it has one, else a glyph for the kind of page it is. */
export function PageIcon({
  doc,
  className,
}: {
  doc: Pick<Doc, "icon" | "kind" | "generated" | "memory_of">;
  className?: string;
}) {
  const icon = doc.icon;
  if (icon && !(icon in NAMED)) {
    return (
      <span
        className={cx("inline-flex size-4 shrink-0 items-center justify-center text-[13px] leading-none", className)}
        aria-hidden
      >
        {icon}
      </span>
    );
  }
  const Glyph = icon
    ? NAMED[icon as keyof typeof NAMED]
    : doc.kind === "database"
      ? Database
      : doc.generated
        ? Sparkles
        : doc.memory_of
          ? Brain
          : FileText;
  return <Glyph className={cx("size-4 shrink-0 text-ink-3", className)} aria-hidden />;
}
