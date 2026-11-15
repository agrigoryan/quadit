import { ImageIcon, Plus } from "lucide-react";
import { t } from "@/lib/i18n";
import { useCover } from "@/docs/db/covers";
import type { Value } from "@/docs/db/formula";
import { RowCardBody } from "@/docs/db/row-card";
import { shownProps, type ViewProps } from "@/docs/db/use-table";
import type { DBProperty, Doc } from "@/lib/types-docs";

function GalleryCard({
  row,
  cells,
  props,
  onOpen,
}: {
  row: Doc;
  cells: Record<string, Value> | undefined;
  props: DBProperty[];
  onOpen: (id: string) => void;
}) {
  const cover = useCover(row);
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-left shadow-card transition-colors hover:border-line-strong"
    >
      <span className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-sunken text-ink-3">
        {cover ? (
          <img src={cover} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-6 opacity-50" aria-hidden />
        )}
      </span>
      <RowCardBody row={row} cells={cells} props={props} className="w-full p-2.5" />
    </button>
  );
}

/** Rows as cards, each with a picture: the cover of the row's page, or the first image in it. */
export function GalleryView({ db, view, rows, onOpen, onAdd }: ViewProps) {
  const props = shownProps(db.table.props, view).slice(0, 4);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3 pt-1 pb-3 max-sm:grid-cols-2 max-sm:gap-2">
      {rows.map((row) => (
        <GalleryCard key={row.id} row={row} cells={db.cells[row.id]} props={props} onOpen={onOpen} />
      ))}
      <button
        type="button"
        onClick={() => onOpen(onAdd())}
        className="flex min-h-32 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong text-sm text-ink-3 hover:bg-hover hover:text-ink"
      >
        <Plus className="size-4" aria-hidden />
        {t("db.newRow")}
      </button>
    </div>
  );
}
