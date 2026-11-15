import { useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { docTitle } from "@/docs/data";
import { updateProperty } from "@/docs/db/actions";
import { computeCells } from "@/docs/db/compute";
import { evalFormula, FUNCTIONS } from "@/docs/db/formula";
import { formulaText } from "@/docs/db/formula-values";
import { PropIcon } from "@/docs/db/prop-meta";
import { useDatabase } from "@/docs/db/use-table";
import type { DBProperty } from "@/docs/types";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

/** How each function is called, and what it gives. */
const HELP: Record<(typeof FUNCTIONS)[number], [string, string]> = {
  prop: ['prop("Name")', t("db.fn.prop")],
  if: ["if(condition, then, else)", t("db.fn.if")],
  concat: ["concat(a, b, …)", t("db.fn.concat")],
  length: ["length(text)", t("db.fn.length")],
  lower: ["lower(text)", t("db.fn.lower")],
  upper: ["upper(text)", t("db.fn.upper")],
  contains: ["contains(text, part)", t("db.fn.contains")],
  empty: ["empty(value)", t("db.fn.empty")],
  round: ["round(number, places)", t("db.fn.round")],
  floor: ["floor(number)", t("db.fn.floor")],
  ceil: ["ceil(number)", t("db.fn.ceil")],
  abs: ["abs(number)", t("db.fn.abs")],
  min: ["min(a, b, …)", t("db.fn.min")],
  max: ["max(a, b, …)", t("db.fn.max")],
  sum: ["sum(a, b, …)", t("db.fn.sum")],
  toNumber: ["toNumber(value)", t("db.fn.toNumber")],
  format: ["format(value)", t("db.fn.format")],
  now: ["now()", t("db.fn.now")],
  today: ["today()", t("db.fn.today")],
  dateAdd: ['dateAdd(date, n, "days")', t("db.fn.dateAdd")],
  dateDiff: ['dateDiff(a, b, "days")', t("db.fn.dateDiff")],
};

const chip = "rounded-sm border border-line bg-surface px-1.5 py-0.5 font-mono text-xs text-ink hover:bg-hover";

/**
 * Writes a formula. What it gives for the first rows shows as you type, and
 * what is wrong with it in plain words; the functions and the properties it
 * can read are one click away.
 */
export function FormulaEditor({ prop, onClose }: { prop: DBProperty; onClose: () => void }) {
  const [draft, setDraft] = useState(prop.config?.formula ?? "");
  const box = useRef<HTMLTextAreaElement>(null);
  const db = useDatabase(prop.database_id);

  // The database as it would be with this formula: the same code that fills the cells.
  const preview = useMemo(() => {
    if (!db) return [];
    const props = db.table.props.map((p) =>
      p.id === prop.id ? { ...p, type: "formula" as const, config: { ...p.config, formula: draft } } : p,
    );
    const rows = db.table.rows.slice(0, 4);
    const cells = computeCells({ ...db.table, props, rows }, db.world);
    return rows.map((r) => ({ id: r.id, title: docTitle(r), text: formulaText(cells[r.id]?.[prop.id]) }));
  }, [db, draft, prop.id]);

  const syntax = draft.trim() ? evalFormula(draft, { prop: () => null }).error : undefined;
  const failed =
    preview.find((p) => p.text.startsWith("#error: "))?.text.slice(8) ?? (preview.length === 0 ? syntax : undefined);
  const others = (db?.table.props ?? []).filter((p) => p.id !== prop.id);

  /** Puts text where the caret is; `inside` leaves the caret between a function's brackets. */
  function insert(text: string, inside = false) {
    const el = box.current;
    const from = el?.selectionStart ?? draft.length;
    const to = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, from) + text + draft.slice(to));
    const caret = from + text.length - (inside ? 1 : 0);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function save() {
    updateProperty(prop.id, { config: { ...prop.config, formula: draft } });
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("db.formula.title", { name: prop.name })}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <textarea
          ref={box}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && save()}
          spellCheck={false}
          rows={4}
          aria-label={t("db.formula.label")}
          aria-invalid={!!failed}
          placeholder={'if(prop("Done"), "shipped", "open")'}
          className="w-full resize-y rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-sm leading-6 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 aria-[invalid=true]:border-danger"
        />
        {failed ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {failed}
          </p>
        ) : (
          preview.length > 0 &&
          draft.trim() !== "" && (
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-x-3 gap-y-1 rounded-md bg-sunken px-3 py-2 text-sm">
              {preview.map((p) => (
                <div key={p.id} className="contents">
                  <dt className="truncate text-ink-2">{p.title}</dt>
                  <dd className="truncate font-mono text-xs leading-5 text-ink">{p.text || "—"}</dd>
                </div>
              ))}
            </dl>
          )
        )}
        {others.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-ink-3">{t("db.formula.props")}</h3>
            <div className="flex flex-wrap gap-1">
              {others.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${chip} inline-flex items-center gap-1 font-sans`}
                  onClick={() => insert(`prop("${p.name}")`)}
                >
                  <PropIcon type={p.type} className="size-3 text-ink-3" />
                  {p.name}
                </button>
              ))}
            </div>
          </section>
        )}
        <section>
          <h3 className="mb-1.5 text-xs font-medium text-ink-3">{t("db.formula.functions")}</h3>
          <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {FUNCTIONS.map((name) => (
              <li key={name} className="flex items-baseline gap-2">
                <button
                  type="button"
                  className={`${chip} shrink-0`}
                  onClick={() => insert(`${name}()`, name !== "now" && name !== "today")}
                >
                  {HELP[name][0]}
                </button>
                <span className="min-w-0 truncate text-xs text-ink-2" title={HELP[name][1]}>
                  {HELP[name][1]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
