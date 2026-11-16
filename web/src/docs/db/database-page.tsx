import { useCallback, useEffect, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { useHotkeys } from "@/hooks/hotkeys";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { createDoc } from "@/docs/actions";
import { useDocsArea } from "@/docs/area";
import { useViews } from "@/docs/data";
import { createView } from "@/docs/db/actions";
import { viewTypeName } from "@/docs/db/prop-meta";
import { BoardView } from "@/docs/db/board-view";
import { CalendarView } from "@/docs/db/calendar-view";
import { applyView } from "@/docs/db/compute";
import { FormView } from "@/docs/db/form-view";
import { GalleryView } from "@/docs/db/gallery-view";
import { RowPeek } from "@/docs/db/row-peek";
import { TableView } from "@/docs/db/table-view";
import { TimelineView } from "@/docs/db/timeline-view";
import { defaultsFor, useDatabase, useEnsureDatabases, type ViewProps } from "@/docs/db/use-table";
import { ViewTabs } from "@/docs/db/view-tabs";
import { ViewToolbar } from "@/docs/db/view-toolbar";
import { useDocsStore } from "@/docs/store";
import type { DBView, Doc, ViewType } from "@/types/docs";
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

/** The table a database is shown in until it has a view of its own. */
const unsavedTable = (databaseId: string): DBView => ({
  id: "",
  database_id: databaseId,
  name: t("db.view.table"),
  type: "table",
  rank: "",
});

/**
 * A database below its title: its views as tabs, the open view with its
 * filters and sorts applied, and a row opened beside it. Which view and
 * which row are open is in the address (?v= and ?peek=), so a link lands
 * on the same thing.
 *
 * Its keys: Cmd+B goes from the table to the board and back (the first view
 * of each), N makes a row and opens it beside, and while a row is open
 * beside, J and K (and the arrows) step to the next or previous row of the
 * view and Enter opens it as a page.
 */
export default function DatabaseView({ doc, readOnly }: { doc: Doc; readOnly: boolean }) {
  const db = useDatabase(doc.id);
  const saved = useViews(doc.id);
  const loaded = useDocsStore((s) => !!s.meta[doc.id]);
  // One who may not change the database is not given a first view (below): they read it in a plain table nobody saved.
  const views = useMemo(
    () => (saved.length === 0 && loaded && readOnly ? [unsavedTable(doc.id)] : saved),
    [saved, loaded, readOnly, doc.id],
  );
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { base } = useDocsArea();
  const view = views.find((v) => v.id === params.get("v")) ?? views[0];
  const peek = params.get("peek");

  useEnsureDatabases(loaded ? [] : [doc.id]);

  // A database with no view yet gets a table, once (by one who may change it).
  const made = useRef(false);
  useEffect(() => {
    if (!loaded || saved.length > 0 || made.current || readOnly) return;
    made.current = true;
    createView(doc.id, "table", t("db.view.table"));
  }, [loaded, saved.length, doc.id, readOnly]);

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

  const props = db?.table.props;
  const addRow = useCallback(
    (values?: Record<string, unknown>, title?: string) =>
      createDoc({
        parentId: doc.id,
        title: title ?? "",
        props: { ...defaultsFor(view, props ?? []), ...values },
      }),
    [doc.id, view, props],
  );

  const adds = !readOnly && view?.type !== "form";
  const other: ViewType = view?.type === "board" ? "table" : "board";
  useHotkeys(
    {
      "mod+b": (e) => {
        e.preventDefault();
        const to = views.find((v) => v.type === other);
        if (to) setParam("v", to.id);
        else toast.info(t("db.view.none", { name: viewTypeName(other) }));
      },
      ...(adds && {
        n: (e: KeyboardEvent) => {
          e.preventDefault();
          openRow(addRow());
        },
      }),
    },
    { guardChords: true },
  );
  const step = (by: number) => (e: KeyboardEvent) => {
    e.preventDefault();
    const next = rows[rows.findIndex((row) => row.id === peek) + by];
    if (next) openRow(next.id);
  };
  useHotkeys(
    {
      j: step(1),
      k: step(-1),
      ArrowDown: step(1),
      ArrowUp: step(-1),
      Enter: (e) => {
        // A button or a link that has the focus answers Enter itself.
        if (e.target instanceof Element && e.target.closest("a, button, [role=button], [role=tab]")) return;
        e.preventDefault();
        void navigate(`${base}/${peek}`);
      },
    },
    { enabled: !!peek },
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
        {adds && (
          <Button variant="primary" size="sm" className="ml-1 shrink-0" onClick={() => openRow(addRow())}>
            <Plus className="size-3.5" aria-hidden />
            <span className="max-sm:sr-only">{t("db.new")}</span>
          </Button>
        )}
      </div>
      <div className="min-w-0 pt-2">
        <Body db={db} view={view} rows={rows} onOpen={openRow} onAdd={addRow} peek={peek} readOnly={readOnly} />
      </div>
      {peek && <RowPeek rowId={peek} onClose={closeRow} readOnly={readOnly} />}
    </section>
  );
}
