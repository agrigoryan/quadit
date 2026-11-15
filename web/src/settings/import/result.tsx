// What an import made, once it has run.

import { CircleCheck } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { countList, foundText, type ImportResult } from "@/settings/import/data";
import { Note } from "@/settings/ui/form";
import { Card } from "@/settings/ui/layout";
import { Button } from "@/ui/button";

interface Props {
  result: ImportResult;
  /** The key of the project the tasks went to, when one was chosen. */
  project: string;
  onAgain: () => void;
}

export function ImportOutcome({ result, project, onAgain }: Props) {
  const slug = useSlug();
  const made = countList(result.made, ["tasks", "comments", "pages", "rows", "files"]);
  const unmatched = result.unmatched_people ?? [];
  const log = result.log ?? [];
  const link = "text-sm font-medium text-accent-text underline-offset-2 hover:underline";
  return (
    <Card className="flex flex-col gap-3.5">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CircleCheck className="size-4 text-ok" aria-hidden />
          {t("import.done")}
        </h3>
        <p className="mt-1 text-sm text-ink">{made ? t("import.made", { list: made }) : t("import.madeNothing")}</p>
        <p className="text-xs text-ink-3">{foundText(result.found)}</p>
      </div>
      {unmatched.length > 0 && (
        <div className="rounded-md bg-wait-soft px-2.5 py-2 text-sm">
          <p className="font-medium text-wait">
            {t("import.unmatched")}: <span className="font-normal">{unmatched.join(", ")}</span>
          </p>
          <p className="mt-0.5 text-xs text-ink-2">{t("import.unmatchedHint")}</p>
        </div>
      )}
      <Note>{t("import.again")}</Note>
      {log.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-default text-ink-2 select-none hover:text-ink">{t("import.log", { n: log.length })}</summary>
          <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-ink-2">{log.join("\n")}</pre>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <Button onClick={onAgain}>{t("import.another")}</Button>
        {result.made.tasks > 0 && project && (
          <Link to={`/${slug}/p/${project}/tasks`} className={link}>
            {t("import.seeTasks")}
          </Link>
        )}
        {result.made.pages > 0 && (
          <Link to={`/${slug}/docs`} className={link}>
            {t("import.seePages")}
          </Link>
        )}
      </div>
    </Card>
  );
}
