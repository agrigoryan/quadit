// A task's own budget: how much money, how many minutes of agent time and
// how many hand-offs between agents its work may take in total. Admins set
// it; nothing set means no limit.

import { type FormEvent, useState } from "react";
import { useCan } from "@/data/access";
import { t } from "@/lib/i18n";
import type { Task } from "@/types/core";
import { moneyMicros } from "@/lib/amounts";
import { setBudget, type TaskBudget } from "@/tasks/actions";
import { PropButton, PropRow } from "@/tasks/properties/panel-row";
import type { PanelProps, TaskProperty } from "@/tasks/properties/property";
import { Button } from "@/ui/button";
import { FormField } from "@/ui/form";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** "$5.00 · 120 min · 3 hand-offs", leaving out what has no limit. */
function summary(b: TaskBudget | undefined): string {
  const parts: string[] = [];
  if (b?.cost_micros) parts.push(moneyMicros(b.cost_micros));
  if (b?.minutes) parts.push(t("prop.budget.minutesShort", { n: b.minutes }));
  if (b?.handoffs) parts.push(t("prop.budget.handoffsShort", { n: b.handoffs }));
  return parts.join(" · ");
}

/** A whole number of zero or more from a box; null when what is typed is not one. */
function whole(text: string, scale = 1): number | null {
  if (text.trim() === "") return 0;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * scale) : null;
}

function BudgetField({ task }: { task: Task }) {
  const budget = task.budget;
  const [open, setOpen] = useState(false);
  const can = useCan();
  const text = summary(budget);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PropButton
          empty={!text}
          disabled={!can.editTask(task)}
          aria-label={`${t("prop.budget")}: ${text || t("prop.budget.none")}`}
        >
          <span className="truncate tnum">{text || t("prop.budget.none")}</span>
        </PropButton>
      </PopoverTrigger>
      <PopoverContent aria-label={t("prop.budget")} className="w-64 p-3">
        {open && <BudgetForm task={task} budget={budget} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function BudgetForm({ task, budget, onDone }: { task: Task; budget: TaskBudget | undefined; onDone: () => void }) {
  const [money, setMoney] = useState(budget?.cost_micros ? String(budget.cost_micros / 1e6) : "");
  const [minutes, setMinutes] = useState(budget?.minutes ? String(budget.minutes) : "");
  const [handoffs, setHandoffs] = useState(budget?.handoffs ? String(budget.handoffs) : "");
  const [error, setError] = useState("");

  function save(e: FormEvent) {
    e.preventDefault();
    const cost = whole(money, 1e6);
    const mins = whole(minutes);
    const hands = whole(handoffs);
    if (cost === null || mins === null || hands === null) return setError(t("prop.budget.bad"));
    setBudget(task, cost || mins || hands ? { cost_micros: cost, minutes: mins, handoffs: hands } : null);
    onDone();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2.5">
      <p className="text-xs text-ink-2">{t("prop.budget.lead")}</p>
      <FormField label={t("prop.budget.money")} htmlFor="budget-money">
        <Input
          id="budget-money"
          autoFocus
          inputMode="decimal"
          value={money}
          onChange={(e) => setMoney(e.target.value)}
          placeholder="0"
        />
      </FormField>
      <FormField label={t("prop.budget.minutes")} htmlFor="budget-minutes">
        <Input
          id="budget-minutes"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          placeholder="0"
        />
      </FormField>
      <FormField label={t("prop.budget.handoffs")} htmlFor="budget-handoffs">
        <Input
          id="budget-handoffs"
          inputMode="numeric"
          value={handoffs}
          onChange={(e) => setHandoffs(e.target.value)}
          placeholder="0"
        />
      </FormField>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {budget && (
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setBudget(task, null);
              onDone();
            }}
          >
            {t("prop.budget.clear")}
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary">
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/** Admins set a task's budget; the server takes it from any member who may edit the task. */
function BudgetRow({ task }: PanelProps) {
  const can = useCan();
  if (!can.administer) return null;
  return (
    <PropRow label={t("prop.budget")}>
      <BudgetField task={task} />
    </PropRow>
  );
}

export const budget = {
  name: "budget",
  title: () => t("prop.budget"),
  Panel: BudgetRow,
  timeline: [{ field: "budget", say: (c) => (c.to ? t("timeline.budgetSet") : t("timeline.budgetCleared")) }],
} satisfies TaskProperty<"budget">;
