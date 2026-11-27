import { t } from "@/lib/i18n";
import type { About } from "@/docs/comments/threads";

/**
 * What a thread is about, above its first comment: the page, a block gone,
 * the words or the block's text; words taken out of the page since are
 * struck through, with a note.
 */
export function Quote({ about }: { about: About }) {
  if (about.on === "page")
    return <p className="mb-1.5 text-xs font-medium text-ink-3">{t("docs.comment.aboutPage")}</p>;
  if (about.on === "gone") return <p className="mb-1.5 text-xs text-ink-3 italic">{t("docs.comment.blockGone")}</p>;
  if (!about.text) return null;
  if (about.on === "removed")
    return (
      <div className="mb-1.5">
        <p className="line-clamp-2 border-l-2 border-line-strong pl-2 text-xs text-ink-3">
          <del>{about.text}</del>
        </p>
        <p className="mt-0.5 text-2xs text-ink-3 italic">{t("docs.comment.wordsGone")}</p>
      </div>
    );
  return <p className="mb-1.5 line-clamp-2 border-l-2 border-move pl-2 text-xs text-ink-2">{about.text}</p>;
}
