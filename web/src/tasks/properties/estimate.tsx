// How much work a task is, where its project estimates: picked from the
// project's scale (tasks/estimates.ts), or typed where it takes any whole
// number. No estimate and an estimate of 0 are two things, where the
// project allows 0.

import { useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { useCan } from "@/data/access";
import { isTyping, useHotkeys } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { getRowEvenIfGone, useLookupEvenIfGone, useRowEvenIfGone, useRows } from "@/data/selectors";
import type { Project, Task } from "@/types/core";
import { setEstimate } from "@/tasks/actions";
import { estimateFromWord, estimateWords, type Scale, scaleOf, sharedScale, sizeOf } from "@/tasks/estimates";
import { Pill, pill } from "@/tasks/properties/create-pill";
import { inlineField, PickerRow, PropRow } from "@/tasks/properties/panel-row";
import {
  type Choice,
  type CreateProps,
  NONE,
  type PanelProps,
  type PickerListProps,
  shared,
  type TaskProperty,
} from "@/tasks/properties/property";
import { noneChoice, noneItem } from "@/tasks/property-picker";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { type PickerItem, PickerList } from "@/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** A picked value's id, and back: "none", or the number. */
const idOf = (value: number | null | undefined) => (value === null || value === undefined ? NONE : String(value));
const valueOf = (id: string) => (id === NONE ? null : Number(id));

/** What a typed number sets: nothing where it is not a whole number, none for 0 where 0 is not an estimate. */
function typed(text: string, scale: Scale): number | null | undefined {
  const n = Number(text);
  if (text.trim() === "" || !Number.isInteger(n) || n < 0) return undefined;
  return n === 0 && !scale.zero ? null : n;
}

/** The rows of a scale's list: none, 0 where it is an estimate, then the scale's values. */
function scaleItems(scale: Scale, values: number[]): PickerItem[] {
  return [
    noneItem(t("prop.noEstimate")),
    ...(scale.zero ? [0] : []).concat(values).map((v) => ({
      id: String(v),
      label: estimateWords(v, scale),
      icon: <Gauge className="size-3.5 text-ink-2" aria-hidden />,
      // A size says its points beside it.
      hint: scale.sizes && sizeOf(v) ? t("prop.points", { n: v }) : undefined,
    })),
  ];
}

/** The scale every one of the tasks' projects takes values of (tasks/estimates.ts sharedScale). */
function useScaleOf(tasks: Task[]): Scale | null {
  const projects = useLookupEvenIfGone("projects");
  return sharedScale([...new Set(tasks.map((task) => task.project_id))].map((id) => projects[id]));
}

interface ChooserProps {
  scale: Scale;
  /** What is set now; undefined where several tasks differ. */
  value: number | null | undefined;
  onPick: (value: number | null) => void;
  /** What the box is called, for a scale of any number. */
  label: string;
}

/** The scale's values to pick from, or, for any whole number, a box to type it in. */
function Chooser({ scale, value, onPick, label }: ChooserProps) {
  if (!scale.values) return <TypedEstimate scale={scale} value={value} onPick={onPick} label={label} />;
  return (
    <PickerList
      items={scaleItems(scale, scale.values)}
      value={value === undefined ? undefined : idOf(value)}
      label={t("prop.set.estimate")}
      placeholder={t("prop.set.estimate")}
      onPick={(id) => onPick(valueOf(id))}
    />
  );
}

/** A whole number of points, typed; or none. */
function TypedEstimate({ scale, value, onPick, label }: ChooserProps) {
  const [text, setText] = useState(() => (value === null || value === undefined ? "" : String(value)));
  const next = typed(text, scale);
  return (
    <form
      className="flex w-60 flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (next !== undefined) onPick(next);
      }}
    >
      <label htmlFor="typed-estimate" className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <Input
        id="typed-estimate"
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onPick(null)}>
          {t("bulk.estimate.clear")}
        </Button>
        <Button type="submit" variant="primary" disabled={next === undefined}>
          {t("bulk.set")}
        </Button>
      </div>
    </form>
  );
}

/** The list a key, the bulk bar or the panel's value opens, for one task or a whole selection. */
function EstimateList({ tasks, close }: PickerListProps) {
  const scale = useScaleOf(tasks);
  if (!scale) return null;
  return (
    <Chooser
      scale={scale}
      value={shared(tasks, (task) => task.estimate ?? null)}
      label={t("bulk.estimate.label", { n: tasks.length })}
      onPick={(value) => {
        setEstimate(tasks, value);
        close();
      }}
    />
  );
}

/** Typed in place, for a project of any whole number; saved on Enter or on leaving the box. Nothing is no estimate. */
function EstimateField({ task, scale, ref }: { task: Task; scale: Scale; ref: PanelProps["takeControl"] }) {
  const [draft, setDraft] = useState<string | null>(null);
  const can = useCan();

  function save() {
    if (draft === null) return;
    const next = typed(draft, scale);
    if (next !== undefined && next !== (task.estimate ?? null)) setEstimate([task], next);
    setDraft(null);
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      aria-label={t("prop.estimate")}
      placeholder={t("detail.estimatePlaceholder")}
      readOnly={!can.editTask(task)}
      value={draft ?? String(task.estimate ?? "")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cx(inlineField, "w-20 tnum [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none")}
    />
  );
}

function EstimateRow(panel: PanelProps) {
  const { task, takeControl } = panel;
  const scale = scaleOf(useRowEvenIfGone("projects", task.project_id));
  if (!scale) return null;
  if (!scale.values)
    return (
      <PropRow label={t("prop.estimate")}>
        <EstimateField task={task} scale={scale} ref={takeControl} />
      </PropRow>
    );
  const value = task.estimate ?? null;
  const words = value === null ? t("prop.noEstimate") : estimateWords(value, scale);
  return (
    <PickerRow property={estimate} panel={panel} value={words} empty={value === null}>
      <Gauge className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{words}</span>
    </PickerRow>
  );
}

/** The create dialog's pill, which Shift+E opens there too (while the caret is in no box). */
function EstimatePill({ project, value, onChange }: CreateProps) {
  const [open, setOpen] = useState(false);
  const scale = scaleOf(project);
  useHotkeys(
    {
      "shift+e": (e) => {
        if (isTyping(e.target)) return;
        e.preventDefault();
        setOpen(true);
      },
    },
    { enabled: !!scale, always: true, layer: "global" },
  );
  if (!scale) return null;
  const set = value.estimate !== null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={pill}>
          <Pill icon={<Gauge className="size-3.5" aria-hidden />} set={set}>
            {value.estimate === null ? t("prop.estimate") : estimateWords(value.estimate, scale)}
          </Pill>
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={t("prop.set.estimate")} className="p-0">
        <Chooser
          scale={scale}
          value={value.estimate}
          label={t("prop.estimate.points")}
          onPick={(estimate) => {
            onChange({ estimate });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The palette's page: the scale's values, or, for any whole number, the one typed in its box. */
function useChoices(task: Task, query: string): Choice[] {
  const scale = scaleOf(useRowEvenIfGone("projects", task.project_id));
  if (!scale) return [];
  const value = task.estimate ?? null;
  const set = (to: number | null) => () => setEstimate([task], to);
  const none = noneChoice(t("prop.noEstimate"), value === null, set(null));
  const choice = (v: number, label = estimateWords(v, scale)): Choice => ({
    id: String(v),
    label,
    words: String(v),
    detail: scale.sizes && sizeOf(v) ? t("prop.points", { n: v }) : undefined,
    icon: <Gauge />,
    checked: v === value,
    apply: set(v),
  });
  if (scale.values) return [none, ...(scale.zero ? [0] : []).concat(scale.values).map((v) => choice(v))];
  const n = typed(query, scale);
  return [
    none,
    ...(value !== null && value !== n ? [choice(value)] : []),
    ...(n !== undefined && n !== null ? [choice(n, t("prop.estimate.setTo", { value: estimateWords(n, scale) }))] : []),
  ];
}

/** The values a filter offers: the scale's, or, for any whole number, those the project's tasks have. */
function useFilterOptions(project: Project | undefined): PickerItem[] {
  const tasks = useRows("tasks");
  return useMemo(() => {
    const scale = scaleOf(project);
    if (!scale) return [];
    const had = tasks.flatMap((task) =>
      task.project_id === project?.id && typeof task.estimate === "number" && task.estimate > 0 ? [task.estimate] : [],
    );
    return scaleItems(scale, scale.values ?? [...new Set(had)].sort((a, b) => a - b));
  }, [project, tasks]);
}

export const estimate = {
  name: "estimate",
  title: () => t("prop.estimate"),
  // Where the project counts them. The server leaves out a switch that is off, so off is "not said".
  appliesTo: (_task, project) => !!project?.settings?.estimates,
  key: { key: "shift+e", shortcut: "shortcuts.estimate" },
  picker: {
    title: () => t("prop.set.estimate"),
    useItems: (tasks) => {
      const scale = useScaleOf(tasks);
      return {
        items: scale?.values ? scaleItems(scale, scale.values) : [],
        value: shared(tasks, (task) => idOf(task.estimate)),
      };
    },
    pick: (tasks, id) => setEstimate(tasks, valueOf(id)),
    List: EstimateList,
  },
  Panel: EstimateRow,
  Create: EstimatePill,
  palette: {
    title: () => t("prop.set.estimate"),
    icon: <Gauge />,
    useChoices,
  },
  bulk: { place: "menu", icon: <Gauge />, label: () => t("prop.set.estimate") },
  timeline: [
    {
      field: "estimate",
      say: (c, { taskId }) => {
        if (typeof c.to !== "number") return t("timeline.estimateCleared");
        const project = getRowEvenIfGone("projects", getRowEvenIfGone("tasks", taskId)?.project_id);
        return t("timeline.estimate", { value: estimateWords(c.to, scaleOf(project)) });
      },
    },
  ],
  filter: {
    word: "estimate",
    title: () => t("filter.estimate"),
    offered: (project) => !!project?.settings?.estimates,
    useOptions: useFilterOptions,
    matches: (task, picked) => picked.includes(idOf(task.estimate)),
    read: (q) => [
      ...new Set(
        (q.estimate ?? []).flatMap((word) => {
          if (word.toLowerCase() === NONE) return [NONE];
          const n = estimateFromWord(word);
          return n === undefined ? [] : [String(n)];
        }),
      ),
    ],
    // The size, on a T-shirt project: ?estimate=M.
    address: (id, c, projectId) => {
      const scale = scaleOf(projectId ? c.projects[projectId] : undefined);
      return (id !== NONE && scale?.sizes && sizeOf(Number(id))) || id;
    },
  },
} satisfies TaskProperty<"estimate">;
