// A text file's contents in the viewer (ui/media.tsx): Markdown rendered, or
// any text as it is written, once its bytes are read (data/file-text.ts).
//
// What is in the file never runs and never becomes the page's markup. The
// source is a string in a <pre>, which React writes as text. Markdown goes
// through the renderer comments and descriptions use (ui/markdown.tsx): HTML
// written in the file comes out as the words it is made of, and addresses
// other than http(s), mailto and the app's own mentions are emptied, so a
// javascript: link goes nowhere. A picture in the file loads when it would
// in a comment: from https or from this site (the page's rules allow no
// other), so a relative one, meant to sit beside the file, shows broken.

import { readError } from "@/data/query";
import { useFileText } from "@/data/file-text";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/types/core";
import { Button, buttonLook } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Markdown } from "@/ui/markdown";
import { Loading } from "@/ui/spinner";

/**
 * The longest Markdown rendered, in characters; a longer file is shown as
 * its source. Rendering is done at once on the page, and very big Markdown
 * would hold it still: measured in the tests' DOM on the build machine,
 * 25,000 characters of mixed Markdown (headings, lists, tables, code) take
 * about 65 ms, 100,000 about a quarter of a second, a megabyte seconds. A
 * report an agent writes runs to tens of thousands of characters and must
 * open rendered, so the limit is where a pause begins to be felt, not where
 * rendering is instant.
 */
export const RENDERED_MARKDOWN_CHARS = 100_000;

/** Whether this Markdown is too long to render (RENDERED_MARKDOWN_CHARS), and is shown as its source. */
export const tooLargeToRender = (text: string) => text.length > RENDERED_MARKDOWN_CHARS;

interface Props {
  file: FileRow;
  /** Markdown as it reads, not as it is written. */
  rendered: boolean;
}

/** The file itself, as the viewer's Download gives it. */
function DownloadLink({ file, className }: { file: FileRow; className?: string }) {
  return (
    <a href={file.url} download={file.name} className={className ?? buttonLook()}>
      {t("viewer.download")}
    </a>
  );
}

export function TextFile({ file, rendered }: Props) {
  const read = useFileText(file);
  if (read.data === undefined) {
    if (!read.error) return <Loading />;
    return (
      <EmptyState
        title={t("viewer.failed")}
        hint={readError(read.error)}
        action={
          <div className="flex gap-2">
            <Button onClick={() => void read.refetch()}>{t("common.tryAgain")}</Button>
            <DownloadLink file={file} />
          </div>
        }
      />
    );
  }
  if (read.data === null)
    return (
      <EmptyState title={t("viewer.notText")} hint={t("viewer.notTextHint")} action={<DownloadLink file={file} />} />
    );

  const { text, cut } = read.data;
  const tooLarge = rendered && tooLargeToRender(text);
  const note = "flex items-center justify-between gap-3 border-b border-line bg-sunken px-4 py-2 text-sm text-ink-2";
  return (
    <>
      {cut && (
        <p className={note}>
          {t("viewer.cut")}
          <DownloadLink file={file} className={buttonLook("secondary", "sm")} />
        </p>
      )}
      {tooLarge && <p className={note}>{t("viewer.tooLarge")}</p>}
      {rendered && !tooLarge ? (
        <Markdown text={text} className="p-4 sm:p-6" />
      ) : (
        <pre className="p-4 font-mono text-sm/5 whitespace-pre-wrap text-ink wrap-anywhere sm:p-6">{text}</pre>
      )}
    </>
  );
}
