import { FileQuestion, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useCan } from "@/lib/access";
import { t } from "@/lib/i18n";
import { useRowEvenIfGone } from "@/lib/selectors";
import { usePageTitle } from "@/lib/ui-state";
import { restoreDoc } from "@/docs/actions";
import { docTitle } from "@/docs/data";
import { PageBody } from "@/docs/page/page-body";
import { PageHeader } from "@/docs/page/page-header";
import { pageUi } from "@/docs/page/state";
import { loadPage } from "@/docs/store";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";

/** One page of the docs: its header and everything under it. */
export function DocPage({ id }: { id: string }) {
  // A page in the trash opens as such, with the way to bring it back.
  const doc = useRowEvenIfGone("docs", id);
  const can = useCan();
  usePageTitle(doc ? docTitle(doc) : t("docs.title"));

  // Comments of another page are not this page's.
  useEffect(() => pageUi.closeComments, [id]);

  if (!doc) return <Unknown id={id} />;
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

/** A page that is not in the workspace copy: ask the server once (a link to a row, a page shared a moment ago). */
function Unknown({ id }: { id: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let gone = false;
    setMissing(false);
    loadPage(id).catch(() => !gone && setMissing(true));
    return () => {
      gone = true;
    };
  }, [id]);
  if (!missing) return <Loading />;
  return <EmptyState icon={<FileQuestion />} title={t("docs.notFound")} hint={t("docs.notFoundHint")} />;
}
