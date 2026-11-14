// The machinery behind the workspace: webhooks, deliveries, repository
// syncs and backups. Quiet when all is well; each problem is one line that
// says what is wrong.

import type { ReactNode } from "react";
import { CircleCheck, DatabaseBackup, TriangleAlert } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMinute } from "@/lib/tick";
import { ago, exact } from "@/lib/time";
import { parseWhen } from "@/insights/lib/format";
import type { Health } from "@/insights/lib/types";
import { Panel } from "@/insights/ui/panel";

function Line({ tone, icon, children }: { tone: "bad" | "warn" | "ok" | "quiet"; icon: ReactNode; children: ReactNode }) {
  const colors = { bad: "text-danger", warn: "text-wait", ok: "text-ok", quiet: "text-ink-3" };
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={cx("mt-0.5 shrink-0 [&>svg]:size-3.5", colors[tone])}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

export function HealthPanel({ health, className }: { health: Health; className?: string }) {
  useMinute();
  const problems: { key: string; tone: "bad" | "warn"; text: string }[] = [];
  const n = (v: number | undefined) => v ?? 0;
  if (n(health.webhooks_failing) > 0)
    problems.push({ key: "hooks", tone: "bad", text: t("dash.health.webhooks", { n: n(health.webhooks_failing) }) });
  if (n(health.deliveries_dead) > 0)
    problems.push({ key: "dead", tone: "bad", text: t("dash.health.dead", { n: n(health.deliveries_dead) }) });
  if (n(health.deliveries_pending) > 0)
    problems.push({ key: "retry", tone: "warn", text: t("dash.health.retrying", { n: n(health.deliveries_pending) }) });
  if (n(health.sources_failing) > 0)
    problems.push({ key: "sync", tone: "bad", text: t("dash.health.sources", { n: n(health.sources_failing) }) });
  if (health.last_backup_ok === false) problems.push({ key: "backup", tone: "bad", text: t("dash.health.backupFailed") });
  const backupAt = parseWhen(health.last_backup);

  return (
    <Panel
      title={t("dash.health")}
      meta={
        problems.length > 0 ? (
          <span className="text-xs font-medium text-danger tnum">{t("dash.health.count", { n: problems.length })}</span>
        ) : undefined
      }
      className={className}
    >
      <ul className="flex flex-col gap-1.5">
        {problems.length === 0 && (
          <Line tone="ok" icon={<CircleCheck aria-hidden />}>
            {t("dash.health.clear")}
            <span className="block text-xs text-ink-3">{t("dash.health.clearHint")}</span>
          </Line>
        )}
        {problems.map((p) => (
          <Line key={p.key} tone={p.tone} icon={<TriangleAlert aria-hidden />}>
            {p.text}
          </Line>
        ))}
        <Line tone="quiet" icon={<DatabaseBackup aria-hidden />}>
          {backupAt > 0 ? (
            <span title={exact(backupAt)}>
              {t(health.last_backup_ok === false ? "dash.health.backupTried" : "dash.health.backup", { when: ago(backupAt) })}
            </span>
          ) : (
            <span className="text-ink-2">{t("dash.health.noBackup")}</span>
          )}
        </Line>
      </ul>
    </Panel>
  );
}
