import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Minus, RefreshCw, TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { api } from "@/data/api";
import { cx } from "@/lib/cx";
import { fileSize } from "@/data/files";
import { formatNumber, t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { Button } from "@/ui/button";
import type { Backup } from "@/admin/backups";
import { changeCatalogQuery } from "@/data/change-catalog";
import { LoadGate } from "@/ui/load-gate";
import { Page, Rows, Section } from "@/ui/page-layout";
import { useNow } from "@/data/live";
import { useQuery } from "@tanstack/react-query";
import { adminKeys } from "@/admin/data";
import { Ago } from "@/ui/ago";

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
  /** Repository syncs and integrations whose last run ended in an error. An older server leaves them out. */
  sources_failing?: number;
  integrations_failing?: number;
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
    <div
      className={cx(
        "flex items-start gap-3 px-3 py-2",
        tone === "warn" && "bg-wait-soft/40",
        tone === "bad" && "bg-danger-soft/50",
      )}
    >
      <span className="pt-0.5">{icons[tone]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <span className="text-sm text-ink">{label}</span>
          <span
            className={cx(
              "text-sm font-medium tnum",
              tone === "warn" ? "text-wait" : tone === "bad" ? "text-danger" : "text-ink",
            )}
          >
            {value}
          </span>
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
  const now = useNow();
  const label = t("admin.health.lastBackup");
  const link = more("/admin/backups", t("admin.nav.backups"));
  if (!backup) {
    return (
      <Line
        tone="warn"
        label={label}
        value={t("admin.health.backupNone")}
        note={
          <>
            {t("admin.health.backupNoneNote")} {link}
          </>
        }
      />
    );
  }
  const when = (
    <span title={exact(backup.started_at)}>
      <Ago ms={backup.started_at} />
    </span>
  );
  if (backup.error)
    return (
      <Line
        tone="bad"
        label={label}
        value={
          <>
            {t("admin.health.backupFailed")} · {when}
          </>
        }
        note={
          <>
            {backup.error} {link}
          </>
        }
      />
    );
  if (!backup.verified_at)
    return (
      <Line
        tone="warn"
        label={label}
        value={
          <>
            {t("admin.health.backupUnverified")} · {when}
          </>
        }
        note={link}
      />
    );
  // Verified, but still only beside the data.
  if (backup.copy_error)
    return (
      <Line
        tone="warn"
        label={label}
        value={
          <>
            {t("admin.health.backupNotCopied")} · {when}
          </>
        }
        note={
          <>
            {backup.copy_error} {link}
          </>
        }
      />
    );
  const old = now - backup.started_at > 3 * 24 * 3600_000;
  return (
    <Line
      tone={old ? "warn" : "ok"}
      label={label}
      value={
        <>
          {t("admin.health.backupVerified")} · {when}
        </>
      }
      note={
        old ? (
          <>
            {t("admin.health.backupOld")} {link}
          </>
        ) : (
          fileSize(backup.size)
        )
      }
    />
  );
}

export function HealthPage() {
  const health = useQuery({
    queryKey: adminKeys.health,
    queryFn: ({ signal }) => api.get<Health>("/api/v1/admin/health", signal),
  });
  // What agents can call has a version of its own, apart from the server's.
  const surface = useQuery({ ...changeCatalogQuery, select: (c) => c.surface });
  const count = (n: number) => (n === 0 ? t("admin.health.zero") : formatNumber(n));
  return (
    <Page
      title={t("admin.health.title")}
      lead={t("admin.health.lead")}
      back="/admin"
      actions={
        <Button onClick={() => void health.refetch()} disabled={health.isFetching}>
          <RefreshCw className={cx("size-3.5", health.isFetching && "animate-spin")} aria-hidden />
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
                  note={
                    h.mail ? undefined : (
                      <>
                        {t("admin.health.mailOffNote")} {more("/admin/mail", t("admin.nav.mail"))}
                      </>
                    )
                  }
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
                  tone={(h.sources_failing ?? 0) > 0 ? "warn" : "ok"}
                  label={t("admin.health.sourcesFailing")}
                  value={count(h.sources_failing ?? 0)}
                  note={(h.sources_failing ?? 0) > 0 ? t("admin.health.sourcesFailingNote") : undefined}
                />
                <Line
                  tone={(h.integrations_failing ?? 0) > 0 ? "warn" : "ok"}
                  label={t("admin.health.integrationsFailing")}
                  value={count(h.integrations_failing ?? 0)}
                  note={(h.integrations_failing ?? 0) > 0 ? t("admin.health.integrationsFailingNote") : undefined}
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
                <Line
                  tone="plain"
                  label={t("admin.health.jobsWaiting")}
                  value={count(h.jobs_waiting)}
                  note={t("admin.health.jobsWaitingNote")}
                />
                <Line tone="plain" label={t("admin.health.deliveriesPending")} value={count(h.deliveries_pending)} />
              </Rows>
            </Section>

            <Section title={t("admin.health.install")}>
              <Rows>
                <Line
                  tone="plain"
                  label={t("admin.health.version")}
                  value={<span className="font-mono text-xs">{h.version}</span>}
                />
                {surface.data && (
                  <Line
                    tone="plain"
                    label={t("admin.health.surface")}
                    value={<span className="font-mono text-xs">{surface.data}</span>}
                    note={t("admin.health.surfaceNote")}
                  />
                )}
                <Line
                  tone="plain"
                  label={t("admin.health.database")}
                  value={t(`admin.health.database.${h.database === "postgres" ? "postgres" : "sqlite"}`)}
                />
                <Line
                  tone="plain"
                  label={t("admin.health.files")}
                  value={t(
                    `admin.storage.kind.${(["s3", "gcs", "azure"] as const).find((k) => k === h.files) ?? "disk"}`,
                  )}
                />
              </Rows>
            </Section>
          </>
        )}
      </LoadGate>
    </Page>
  );
}
