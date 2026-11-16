import { FileQuestion, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import { isNotFound, readError } from "@/data/query";
import { useRowEvenIfGone, useSlug } from "@/data/selectors";
import { usePageTitle } from "@/lib/ui-state";
import { useEscapeBack } from "@/nav/escape-back";
import { restoreDoc } from "@/docs/actions";
import { useDocsArea } from "@/docs/area";
import { docTitle } from "@/docs/data";
import { PageBody } from "@/docs/page/page-body";
import { PageHeader } from "@/docs/page/page-header";
import { pageUi, usePageUi } from "@/docs/page/state";
import { pageQuery } from "@/docs/store";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { LoadFailed } from "@/ui/load-gate";
import { Loading } from "@/ui/spinner";

/** One page of the docs: its header and everything under it. */
export function DocPage({ id }: { id: string }) {
  // A page in the trash opens as such, with the way to bring it back.
  const doc = useRowEvenIfGone("docs", id);
  const can = useCan();
  usePageTitle(doc ? docTitle(doc) : t("docs.title"));
  // Escape is the comments column's own while it is open.
  useEscapeBack(useDocsArea().base, !usePageUi((s) => s.commentsOpen));

  // Comments of another page are not this page's.
  useEffect(() => pageUi.closeComments, [id]);

  if (!doc) return <Unknown key={id} id={id} />;
  if (doc.deleted_at) {
    return (
      <EmptyState
        icon={<Trash2 />}
        title={t("docs.trash.inTrash", { title: docTitle(doc) })}
        hint={t("docs.trash.inTrashHint")}
        action={
          can.edit(doc.project_id) && (
            <Button variant="primary" onClick={() => restoreDoc(doc.id)}>
              {t("docs.trash.restore")}
            </Button>
          )
        }
      />
    );
  }
  return (
    <div className="flex h-full min-w-0 flex-col">
      <PageHeader doc={doc} />
      <PageBody key={doc.id} doc={doc} />
    </div>
  );
}

/**
 * A page that is not in the workspace copy: ask the server (a link to a row,
 * a page shared a moment ago). Once it answers, the page is in the copy and
 * DocPage shows it. Only the server saying it is not there is "not found".
 */
function Unknown({ id }: { id: string }) {
  const page = useQuery(pageQuery(useSlug(), id));
  if (!page.error || page.isFetching) return <Loading />;
  if (isNotFound(page.error))
    return <EmptyState icon={<FileQuestion />} title={t("docs.notFound")} hint={t("docs.notFoundHint")} />;
  const why = readError(page.error);
  // A 401: the person is on the way to sign in.
  return why ? <LoadFailed error={why} onRetry={() => void page.refetch()} /> : null;
}
