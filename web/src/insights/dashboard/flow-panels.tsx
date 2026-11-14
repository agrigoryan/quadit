// Flow: where the tasks are now, how many come in and get done each week,
// and whose turn has lasted longest.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import { DataTable, TableSwitch } from "@/insights/charts/base";
import { statusRows, StatusStack } from "@/insights/charts/status-stack";
import { WeeklyBars, weeklyRows } from "@/insights/charts/weekly-bars";
import { hours } from "@/insights/lib/format";
import { useMembersByHandle } from "@/insights/lib/members";
import type { StatusCount, WaitRow, WeekCount } from "@/insights/lib/types";
import { Panel, PanelEmpty } from "@/insights/ui/panel";
import { Avatar } from "@/ui/avatar";

export function StatusPanel({ rows, className }: { rows: StatusCount[]; className?: string }) {
  const [table, setTable] = useState(false);
  const projects = useCollection("projects");
  const names: Record<string, string> = {};
  for (const p of Object.values(projects)) names[p.key] = p.name;
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return (
    <Panel title={t("dash.status")} action={total > 0 && <TableSwitch on={table} onChange={setTable} />} className={className}>
      {total === 0 ? (
        <p className="text-sm text-ink-2">{t("dash.status.empty")}</p>
      ) : table ? (
        <DataTable caption={t("dash.status")} head={[t("dash.status.col"), t("dash.col.tasks")]} rows={statusRows(rows)} />
      ) : (
        <StatusStack rows={rows} names={names} />
      )}
    </Panel>
  );
}

export function WeeklyPanel({ weeks, className }: { weeks: WeekCount[]; className?: string }) {
  const [table, setTable] = useState(false);
  const opened = weeks.reduce((sum, w) => sum + w.opened, 0);
  const closed = weeks.reduce((sum, w) => sum + w.closed, 0);
  return (
    <Panel
      title={t("dash.weekly")}
      meta={<span className="text-xs text-ink-3 tnum max-sm:hidden">{t("dash.weekly.totals", { opened, closed, n: weeks.length })}</span>}
      action={<TableSwitch on={table} onChange={setTable} />}
      className={className}
    >
      {table ? (
        <DataTable
          caption={t("dash.weekly")}
          head={[t("dash.weekly.col"), t("ins.chart.opened"), t("ins.chart.closed")]}
          rows={weeklyRows(weeks)}
        />
      ) : (
        <WeeklyBars weeks={weeks} />
      )}
    </Panel>
  );
}

/** Who has been holding things up longest. People and agents are told apart by avatar and by word. */
export function WaitsPanel({ rows, className }: { rows: WaitRow[]; className?: string }) {
  const find = useMembersByHandle();
  const longest = Math.max(1, ...rows.map((r) => r.oldest_hours));
  return (
    <Panel title={t("dash.waits")} className={className} flush>
      {rows.length === 0 ? (
        <PanelEmpty>{t("dash.waits.empty")}</PanelEmpty>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-xs text-ink-3">
              <th scope="col" className="border-b border-line/70 py-1 pl-4 text-left font-medium">
                {t("dash.waits.who")}
              </th>
              <th scope="col" className="border-b border-line/70 px-2 py-1 text-right font-medium">
                {t("dash.col.tasks")}
              </th>
              <th scope="col" className="border-b border-line/70 px-2 py-1 text-right font-medium max-sm:hidden">
                {t("dash.waits.average")}
              </th>
              <th scope="col" className="border-b border-line/70 py-1 pr-4 pl-2 text-right font-medium">
                {t("dash.waits.oldest")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const member = find(row.member);
              return (
                <tr key={row.member}>
                  <th scope="row" className="border-b border-line/70 py-1.5 pl-4 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar member={member} size="sm" />
                      <span className="truncate">{row.kind === "agent" ? row.member : (member?.name ?? row.member)}</span>
                      <span className="shrink-0 text-xs text-ink-3">
                        {t(row.kind === "agent" ? "dash.waits.agent" : "dash.waits.person")}
                      </span>
                    </span>
                  </th>
                  <td className="border-b border-line/70 px-2 py-1.5 text-right tnum">{row.tasks}</td>
                  <td className="border-b border-line/70 px-2 py-1.5 text-right text-ink-2 tnum max-sm:hidden">{hours(row.avg_hours)}</td>
                  <td className="border-b border-line/70 py-1.5 pr-4 pl-2 text-right tnum">
                    <span className="inline-flex items-center justify-end gap-2">
                      <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-sunken dark:bg-press max-sm:hidden">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${(row.oldest_hours / longest) * 100}%`, background: "var(--viz-waiting)" }}
                        />
                      </span>
                      {hours(row.oldest_hours)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
