// How an agent's state is shown, on the dashboard and on the agents page:
// what it is doing, whether anything would wake it, and what it has spent
// this week against its budget. A state is always an icon and words, never
// colour alone.

import "@/insights/viz.css";
import { CircleDashed, EarOff, Hourglass, Inbox, Loader } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { money, minutes } from "@/insights/lib/format";
import type { AgentState, AgentStateName } from "@/insights/lib/types";

const looks: Record<AgentStateName, { icon: typeof Loader; tone: string }> = {
  working: { icon: Loader, tone: "bg-accent-soft text-accent-text" },
  waiting: { icon: Hourglass, tone: "bg-wait-soft text-wait" },
  has_work: { icon: Inbox, tone: "bg-sunken text-ink border-line-strong" },
  idle: { icon: CircleDashed, tone: "bg-sunken text-ink-2 border-line" },
};

/** "Working", "Waiting", "Has work", "Idle" as a small chip. */
export function AgentStateChip({ state, className }: { state: AgentStateName; className?: string }) {
  const look = looks[state] ?? looks.idle;
  const Icon = look.icon;
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap",
        look.tone,
        className,
      )}
    >
      <Icon className={cx("size-3", state === "working" && "animate-spin [animation-duration:2.4s]")} aria-hidden />
      {t(`ins.agent.state.${state}` as "ins.agent.state.idle")}
    </span>
  );
}

/**
 * The flag for an agent nothing would wake: no companion is holding a wait
 * for it and no webhook pushes to it. Loud when work is queued for it.
 */
export function NotListening({ urgent, className }: { urgent?: boolean; className?: string }) {
  return (
    <span
      title={t("ins.agent.notListeningHint")}
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap",
        urgent ? "bg-danger-soft text-danger" : "border border-line text-ink-3",
        className,
      )}
    >
      <EarOff className="size-3" aria-hidden />
      {t(urgent ? "ins.agent.notListeningUrgent" : "ins.agent.notListening")}
    </span>
  );
}

/** An agent that has work queued but would not hear about it. */
export const isStranded = (a: AgentState) => !a.listening && a.state !== "working" && (a.waiting_on_it > 0 || a.state === "has_work");

interface BudgetProps {
  agent: Pick<AgentState, "cost_week" | "minutes_week" | "budget">;
  className?: string;
}

/**
 * This week's cost as a meter against the weekly budget, with the amounts
 * written out. Without a budget there is no meter, only what was spent.
 */
export function BudgetBar({ agent, className }: BudgetProps) {
  const cost = Number(agent.cost_week ?? 0) || 0;
  const budget = Number(agent.budget ?? 0) || 0;
  const time = agent.minutes_week ? minutes(agent.minutes_week) : "";
  if (budget <= 0) {
    return (
      <p className={cx("text-xs text-ink-3 tnum", className)}>
        {cost > 0 || time
          ? t("ins.agent.spentNoBudget", { cost: money(cost), time: time || t("ins.time.m", { m: 0 }) })
          : t("ins.agent.nothingSpent")}
      </p>
    );
  }
  const share = cost / budget;
  const level = share >= 1 ? "over" : share >= 0.8 ? "near" : "ok";
  const fill = level === "over" ? "var(--viz-over)" : level === "near" ? "var(--viz-warn)" : "var(--viz-started)";
  const label = t("ins.agent.budget", { cost: money(cost), budget: money(budget) });
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2 text-xs tnum">
        <span className="text-ink-2">
          {label}
          {level !== "ok" && (
            <span className={cx("ml-1.5 font-medium", level === "over" ? "text-danger" : "text-wait")}>
              {t(`ins.agent.budget.${level}`)}
            </span>
          )}
        </span>
        {time && <span className="text-ink-3">{time}</span>}
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(cost, budget)}
        aria-valuetext={`${Math.round(share * 100)}%`}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken dark:bg-press"
      >
        <div className="h-full rounded-full" style={{ width: `${Math.min(1, share) * 100}%`, background: fill }} />
      </div>
    </div>
  );
}
