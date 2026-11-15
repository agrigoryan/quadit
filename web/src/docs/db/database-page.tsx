import { useCallback, useEffect, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import { useSearchParams } from "react-router";
import { t } from "@/lib/i18n";
import { createDoc } from "@/docs/actions";
import { useViews } from "@/docs/data";
import { createView } from "@/docs/db/actions";
import { BoardView } from "@/docs/db/board-view";
import { CalendarView } from "@/docs/db/calendar-view";
import { applyView } from "@/docs/db/compute";
import { FormView } from "@/docs/db/form-view";
import { GalleryView } from "@/docs/db/gallery-view";
import { RowPeek } from "@/docs/db/row-peek";
import { TableView } from "@/docs/db/table-view";
import { TimelineView } from "@/docs/db/timeline-view";
import { defaultsFor, ensureDatabase, useDatabase, type ViewProps } from "@/docs/db/use-table";
import { ViewTabs } from "@/docs/db/view-tabs";
import { ViewToolbar } from "@/docs/db/view-toolbar";
import { useDocsStore } from "@/docs/store";
import type { Doc, ViewType } from "@/lib/types-docs";
import { Button } from "@/ui/button";
import { Loading } from "@/ui/spinner";

const VIEWS: Record<ViewType, (props: ViewProps) => React.ReactNode> = {
  table: TableView,
  board: BoardView,
  calendar: CalendarView,
  gallery: GalleryView,
  timeline: TimelineView,
  form: FormView,
};

/**
 * A database below its title: its views as tabs, the open view with its
 * filters and sorts applied, and a row opened beside it. Which view and
 * which row are open is in the address (?v= and ?peek=), so a link lands
 * on the same thing.
 */
export default function DatabaseView({ doc, readOnly }: { doc: Doc; readOnly: boolean }) {
  const db = useDatabase(doc.id);
  const views = useViews(doc.id);
  const loaded = useDocsStore((s) => !!s.meta[doc.id]);
  const [params, setParams] = useSearchParams();
  const view = views.find((v) => v.id === params.get("v")) ?? views[0];
  const peek = params.get("peek");

  useEffect(() => {
    if (!loaded) ensureDatabase(doc.id);
  }, [loaded, doc.id]);

  // A database with no view yet gets a table, once (by one who may change it).
  const made = useRef(false);
  useEffect(() => {
    if (!loaded || views.length > 0 || made.current || readOnly) return;
    made.current = true;
    createView(doc.id, "table", t("db.view.table"));
  }, [loaded, views.length, doc.id, readOnly]);

  const setParam = useCallback(
    (name: string, value: string | null) =>
      setParams(
        (cur) => {
          const next = new URLSearchParams(cur);
          if (value) next.set(name, value);
          else next.delete(name);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const openRow = useCallback((rowId: string) => setParam("peek", rowId), [setParam]);
  const closeRow = useCallback(() => setParam("peek", null), [setParam]);

  const rows = useMemo(
    () => (db && view ? applyView(db.table, db.cells, view.config?.filters, view.config?.sorts) : []),
    [db, view],
  );

  const viewRef = useRef(view);
  viewRef.current = view;
  const propsRef = useRef(db?.table.props ?? []);
  propsRef.current = db?.table.props ?? [];
  const addRow = useCallback(
    (values?: Record<string, unknown>, title?: string) =>
      createDoc({
        parentId: doc.id,
        title: title ?? "",
        props: { ...defaultsFor(viewRef.current, propsRef.current), ...values },
      }),
    [doc.id],
  );

  if (!db || !loaded || !view) return <Loading />;
  const Body = VIEWS[view.type] ?? TableView;

  return (
    <section aria-label={doc.title} className="flex min-w-0 flex-col px-4 pt-2 pb-24 sm:px-8">
      <div className="flex items-center gap-1 border-b border-line">
        <ViewTabs
          databaseId={doc.id}
          views={views}
          active={view}
          onPick={(id) => setParam("v", id)}
          readOnly={readOnly}
        />
        <ViewToolbar view={view} props={db.table.props} readOnly={readOnly} />
        {view.type !== "form" && !readOnly && (
          <Button variant="primary" size="sm" className="ml-1 shrink-0" onClick={() => openRow(addRow())}>
            <Plus className="size-3.5" aria-hidden />
            <span className="max-sm:sr-only">{t("db.new")}</span>
            <span className="sr-only sm:hidden">{t("db.new")}</span>
          </Button>
        )}
      </div>
      <div className="min-w-0 pt-2">
        <Body db={db} view={view} rows={rows} onOpen={openRow} onAdd={addRow} readOnly={readOnly} />
      </div>
      {peek && <RowPeek rowId={peek} onClose={closeRow} readOnly={readOnly} />}
    </section>
  );
}
