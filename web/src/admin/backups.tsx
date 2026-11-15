import { useState } from "react";
import { ArchiveRestore, CircleAlert, CircleCheck, Download, LoaderCircle } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { fileSize } from "@/lib/files";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { RestoreItemDialog } from "@/admin/restore-item";
import { NumberField, SettingForm } from "@/admin/setting-form";
import { useDraft } from "@/admin/settings";
import { download } from "@/lib/download";
import { LoadGate } from "@/ui/load-gate";
import { FormAlert, SwitchRow } from "@/ui/form";
import { EmptyRow, Page, Row, Rows, Section } from "@/ui/settings-layout";
import { useLoad } from "@/lib/use-load";

export interface Backup {
  id: string;
  started_at: number;
  finished_at?: number;
  location?: string;
  size: number;
  sha256?: string;
  verified_at?: number;
  error?: string;
}

interface BackupList {
  backups: Backup[];
  directory: string;
}

interface Schedule {
  enabled: boolean;
  hour: number;
  keep?: number;
  copy_to_files: boolean;
}

const noSchedule: Schedule = { enabled: false, hour: 3, copy_to_files: false };

function ScheduleForm() {
  const form = useDraft<Schedule>("backup", noSchedule, {
    validate: (v) => {
      const wrong: Record<string, string> = {};
      if (v.hour < 0 || v.hour > 23) wrong.hour = t("admin.backups.hourBad");
      if (v.keep !== undefined && v.keep < 1) wrong.keep = t("admin.backups.keepBad");
      return wrong;
    },
    toValue: (v) => ({ ...v, keep: v.keep || undefined }),
  });
  const d = form.draft;
  return (
    <SettingForm of={form}>
      <SwitchRow
        title={t("admin.backups.daily")}
        hint={t("admin.backups.dailyHint")}
        checked={d.enabled}
        disabled={form.locked}
        onChange={(enabled) => form.set({ enabled })}
      />
      <div className="flex flex-wrap gap-x-6 gap-y-3.5">
        <NumberField
          label={t("admin.backups.hour")}
          value={d.hour}
          onChange={(hour) => form.set({ hour: hour ?? 0 })}
          min={0}
          max={23}
          unit="UTC"
          hint={t("admin.backups.hourHint")}
          error={form.errors.fields.hour}
        />
        <NumberField
          label={t("admin.backups.keep")}
          value={d.keep || undefined}
          onChange={(keep) => form.set({ keep })}
          min={1}
          placeholder="14"
          hint={t("admin.backups.keepHint")}
          error={form.errors.fields.keep}
        />
      </div>
      <SwitchRow
        title={t("admin.backups.copy")}
        hint={t("admin.backups.copyHint")}
        checked={d.copy_to_files}
        disabled={form.locked}
        onChange={(copy_to_files) => form.set({ copy_to_files })}
      />
    </SettingForm>
  );
}

function BackupRow({ backup, onRestore }: { backup: Backup; onRestore: () => void }) {
  const running = !backup.finished_at && !backup.error;
  const file = backup.location?.split("/").pop() ?? backup.id;
  return (
    <Row
      lead={
        backup.error ? (
          <CircleAlert className="size-4 text-danger" aria-hidden />
        ) : running ? (
          <LoaderCircle className="size-4 animate-spin text-ink-3" aria-hidden />
        ) : (
          <CircleCheck className="size-4 text-ok" aria-hidden />
        )
      }
      title={<span title={exact(backup.started_at)}>{exact(backup.started_at)}</span>}
      sub={
        backup.error ? <span className="text-danger">{backup.error}</span> : <span className="font-mono">{file}</span>
      }
      meta={
        <>
          {!backup.error && !running && <span className="tnum max-sm:hidden">{fileSize(backup.size)}</span>}
          {backup.error ? (
            <Badge tone="danger">{t("admin.backups.failed")}</Badge>
          ) : running ? (
            <Badge>{t("admin.backups.running")}</Badge>
          ) : backup.verified_at ? (
            <Badge tone="ok">{t("admin.backups.verified")}</Badge>
          ) : (
            <Badge tone="wait">{t("admin.backups.unverified")}</Badge>
          )}
        </>
      }
      actions={
        !backup.error && !running ? (
          <>
            <Button variant="ghost" size="sm" onClick={onRestore} className="max-sm:hidden">
              {t("admin.restoreItem.open")}
            </Button>
            <IconButton label={t("admin.restoreItem.open")} onClick={onRestore} className="sm:hidden">
              <ArchiveRestore className="size-4" />
            </IconButton>
            <IconButton label={t("s.download")} onClick={() => download(`/api/v1/admin/backups/${backup.id}/download`)}>
              <Download className="size-4" />
            </IconButton>
          </>
        ) : (
          <span className="size-7" />
        )
      }
    />
  );
}

export function BackupsPage() {
  const list = useLoad(() => api.get<BackupList>("/api/v1/admin/backups"), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState<Backup | null>(null);

  async function backUpNow() {
    setBusy(true);
    setError("");
    try {
      await api.post<Backup>("/api/v1/admin/backups");
      toast.info(t("admin.backups.done"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      void list.reload();
    }
  }

  return (
    <Page title={t("admin.backups.title")} lead={t("admin.backups.lead")} back="/admin">
      <Section title={t("admin.backups.schedule")}>
        <ScheduleForm />
      </Section>

      <Section
        title={t("admin.backups.list")}
        lead={list.data ? t("admin.backups.directory", { dir: list.data.directory }) : undefined}
        actions={
          <Button variant="primary" disabled={busy} onClick={() => void backUpNow()}>
            {busy ? t("admin.backups.nowBusy") : t("admin.backups.now")}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <FormAlert>{error}</FormAlert>
          <LoadGate of={list}>
            {(data) =>
              data.backups.length === 0 ? (
                <EmptyRow>{t("admin.backups.none")}</EmptyRow>
              ) : (
                <Rows>
                  {data.backups.map((b) => (
                    <BackupRow key={b.id} backup={b} onRestore={() => setRestoring(b)} />
                  ))}
                </Rows>
              )
            }
          </LoadGate>
          <p className="text-xs text-ink-3">{t("admin.backups.restoreHint")}</p>
        </div>
      </Section>
      {restoring && <RestoreItemDialog backup={restoring} onClose={() => setRestoring(null)} />}
    </Page>
  );
}
