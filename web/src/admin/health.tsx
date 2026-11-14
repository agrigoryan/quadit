import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Minus, RefreshCw, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { fileSize } from "@/lib/files";
import { t } from "@/lib/i18n";
import { ago, exact } from "@/lib/time";
import { Button } from "@/ui/button";
import type { Backup } from "@/admin/backups";
import { LoadGate } from "@/settings/ui/bits";
import { Page, Rows, Section } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";

interface Health {
  version: string;
  database: string;
  files: string;
  mail: boolean;
  jobs_waiting: number;
  jobs_failing: number;
  webhooks_failing: number;
  deliveries_dead: number;
  deliveries_pending: number;
  last_backup?: Backup;
}

type Tone = "ok" | "warn" | "bad" | "plain";

const icons: Record<Tone, ReactNode> = {
  ok: <CircleCheck className="size-4 text-ok" aria-hidden />,
  warn: <TriangleAlert className="size-4 text-wait" aria-hidden />,
  bad: <CircleAlert className="size-4 text-danger" aria-hidden />,
  plain: <Minus className="size-4 text-ink-3" aria-hidden />,
};

interface LineProps {
  tone: Tone;
  label: string;
  value: ReactNode;
  /** What it means or what to do, when it needs saying. */
  note?: ReactNode;
}

/** One fact about the install: calm when fine, a warning tone when it needs attention. */
function Line({ tone, label, value, note }: LineProps) {
  return (
    <div className={cx("flex items-start gap-3 px-3 py-2", tone === "warn" && "bg-wait-soft/40", tone === "bad" && "bg-danger-soft/50")}>
      <span className="pt-0.5">{icons[tone]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <span className="text-sm text-ink">{label}</span>
          <span className={cx("text-sm font-medium tnum", tone === "warn" ? "text-wait" : tone === "bad" ? "text-danger" : "text-ink")}>{value}</span>
        </div>
        {note && <p className="mt-0.5 text-xs text-ink-2">{note}</p>}
      </div>
    </div>
  );
}

const more = (to: string, text: string) => (
  <Link to={to} className="font-medium text-accent-text underline-offset-2 hover:underline">
    {text}
  </Link>
);

function BackupLine({ backup }: { backup: Backup | undefined }) {
  const label = t("admin.health.lastBackup");
  const link = more("/admin/backups", t("admin.nav.backups"));
  if (!backup) {
    return <Line tone="warn" label={label} value={t("admin.health.backupNone")} note={<>{t("admin.health.backupNoneNote")} {link}</>} />;
  }
  const when = <span title={exact(backup.started_at)}>{ago(backup.started_at)}</span>;
  if (backup.error) return <Line tone="bad" label={label} value={<>{t("admin.health.backupFailed")} · {when}</>} note={<>{backup.error} {link}</>} />;
  if (!backup.verified_at) return <Line tone="warn" label={label} value={<>{t("admin.health.backupUnverified")} · {when}</>} note={link} />;
  const old = Date.now() - backup.started_at > 3 * 24 * 3600_000;
  return (
    <Line
      tone={old ? "warn" : "ok"}
      label={label}
      value={<>{t("admin.health.backupVerified")} · {when}</>}
      note={old ? <>{t("admin.health.backupOld")} {link}</> : fileSize(backup.size)}
    />
  );
}

export function HealthPage() {
  const health = useLoad(() => api.get<Health>("/api/v1/admin/health"), []);
  const count = (n: number) => (n === 0 ? t("admin.health.zero") : String(n));
  return (
    <Page
      title={t("admin.health.title")}
      lead={t("admin.health.lead")}
      back="/admin"
      actions={
        <Button onClick={() => void health.reload()} disabled={health.loading}>
          <RefreshCw className={cx("size-3.5", health.loading && "animate-spin")} aria-hidden />
          {t("s.refresh")}
        </Button>
      }
    >
      <LoadGate of={health}>
        {(h) => (
          <>
            <Section title={t("admin.health.attention")}>
              <Rows>
                <BackupLine backup={h.last_backup} />
                <Line
                  tone={h.mail ? "ok" : "warn"}
                  label={t("admin.health.mail")}
                  value={h.mail ? t("admin.health.mailOn") : t("admin.health.mailOff")}
                  note={h.mail ? undefined : <>{t("admin.health.mailOffNote")} {more("/admin/mail", t("admin.nav.mail"))}</>}
                />
                <Line
                  tone={h.webhooks_failing > 0 ? "warn" : "ok"}
                  label={t("admin.health.webhooksFailing")}
                  value={count(h.webhooks_failing)}
                  note={h.webhooks_failing > 0 ? t("admin.health.webhooksFailingNote") : undefined}
                />
                <Line
                  tone={h.deliveries_dead > 0 ? "bad" : "ok"}
                  label={t("admin.health.deliveriesDead")}
                  value={count(h.deliveries_dead)}
                  note={h.deliveries_dead > 0 ? t("admin.health.deliveriesDeadNote") : undefined}
                />
                <Line
                  tone={h.jobs_failing > 0 ? "warn" : "ok"}
                  label={t("admin.health.jobsFailing")}
                  value={count(h.jobs_failing)}
                  note={h.jobs_failing > 0 ? t("admin.health.jobsFailingNote") : undefined}
                />
              </Rows>
            </Section>

            <Section title={t("admin.health.queues")}>
              <Rows>
                <Line tone="plain" label={t("admin.health.jobsWaiting")} value={count(h.jobs_waiting)} note={t("admin.health.jobsWaitingNote")} />
                <Line tone="plain" label={t("admin.health.deliveriesPending")} value={count(h.deliveries_pending)} />
              </Rows>
            </Section>

            <Section title={t("admin.health.install")}>
              <Rows>
                <Line tone="plain" label={t("admin.health.version")} value={<span className="font-mono text-xs">{h.version}</span>} />
                <Line tone="plain" label={t("admin.health.database")} value={t(`admin.health.database.${h.database === "postgres" ? "postgres" : "sqlite"}`)} />
                <Line tone="plain" label={t("admin.health.files")} value={t(`admin.storage.kind.${(["s3", "gcs", "azure"] as const).find((k) => k === h.files) ?? "disk"}`)} />
              </Rows>
            </Section>
          </>
        )}
      </LoadGate>
    </Page>
  );
}
