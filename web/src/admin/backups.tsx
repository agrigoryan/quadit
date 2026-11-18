import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArchiveRestore, CircleAlert, CircleCheck, Download, LoaderCircle } from "lucide-react";
import { api, errorMessage } from "@/data/api";
import { fileSize } from "@/data/files";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { RestoreItemDialog } from "@/admin/restore-item";
import {
  type Bucket,
  BucketFields,
  type CloudKind,
  bucketErrors,
  bucketValue,
  cloudKinds,
  noBucket,
} from "@/admin/bucket";
import { NumberField, SettingForm, TextField } from "@/admin/setting-form";
import { useDraft, useSetting } from "@/admin/settings";
import { download } from "@/lib/download";
import { LoadGate } from "@/ui/load-gate";
import { FormAlert, FormField, NativeSelect, SwitchRow } from "@/ui/form";
import { EmptyRow, Page, Row, Rows, Section } from "@/ui/page-layout";
import { adminKeys } from "@/admin/data";
import { queryClient } from "@/data/query";

export interface Backup {
  id: string;
  started_at: number;
  finished_at?: number;
  location?: string;
  size: number;
  sha256?: string;
  verified_at?: number;
  error?: string;
  /** When the copy the setting asks for got there. */
  copied_at?: number;
  /** Why that copy did not get there. */
  copy_error?: string;
}

interface BackupList {
  backups: Backup[];
  directory: string;
}

/** Where each backup is also copied: nowhere (""), file storage, a folder on the server, or a bucket of its own. */
interface CopyTo {
  kind: "" | "files" | "folder" | "bucket";
  folder: string;
  bucket: Bucket;
}

interface Schedule {
  enabled: boolean;
  hour: number;
  keep?: number;
  copy_to: CopyTo;
}

const noCopy: CopyTo = { kind: "", folder: "", bucket: noBucket };
const noSchedule: Schedule = { enabled: false, hour: 3, copy_to: noCopy };

/** A stored copy_to with every field, whatever the server left out. */
const fullCopy = (c: Partial<CopyTo> | undefined): CopyTo => ({
  ...noCopy,
  ...c,
  bucket: { ...noBucket, ...c?.bucket },
});

/** The one choice the form shows: the kind of place, a bucket by its cloud. */
type Choice = "" | "files" | "folder" | CloudKind;

const choiceOf = (c: CopyTo): Choice =>
  c.kind === "bucket" ? (c.bucket.kind === "disk" ? "s3" : c.bucket.kind) : c.kind;

function chosen(c: CopyTo, choice: Choice): CopyTo {
  if (choice === "" || choice === "files" || choice === "folder") return { ...c, kind: choice };
  return { ...c, kind: "bucket", bucket: { ...c.bucket, kind: choice } };
}

/** What is sent of where to copy: only what its kind uses; a bucket's secrets are forgotten when it is not one. */
function copyValue(c: CopyTo): CopyTo {
  return {
    kind: c.kind,
    folder: c.kind === "folder" ? c.folder.trim() : "",
    bucket: bucketValue(c.kind === "bucket" ? c.bucket : noBucket),
  };
}

function ScheduleForm() {
  const stored = fullCopy(useSetting<Schedule>("backup", noSchedule).value.copy_to);
  const form = useDraft<Schedule>("backup", noSchedule, {
    validate: (v) => {
      const wrong: Record<string, string> = {};
      if (v.hour < 0 || v.hour > 23) wrong.hour = t("admin.backups.hourBad");
      if (v.keep !== undefined && v.keep < 1) wrong.keep = t("admin.backups.keepBad");
      const copy = fullCopy(v.copy_to);
      if (copy.kind === "folder" && !copy.folder.trim()) wrong.folder = t("s.required");
      if (copy.kind === "bucket") Object.assign(wrong, bucketErrors(copy.bucket));
      return wrong;
    },
    toValue: (v) => ({ ...v, keep: v.keep || undefined, copy_to: copyValue(fullCopy(v.copy_to)) }),
  });
  const d = form.draft;
  const copy = fullCopy(d.copy_to);
  const setCopy = (next: Partial<CopyTo>) => form.set({ copy_to: { ...copy, ...next } });
  const choice = choiceOf(copy);
  const choices: Choice[] = ["", "files", "folder", ...cloudKinds];
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
      <FormField
        label={t("admin.backups.copyTo")}
        htmlFor="backup-copy-to"
        hint={t(`admin.backups.copyToHint.${choice || "none"}`)}
      >
        <NativeSelect
          id="backup-copy-to"
          value={choice}
          onChange={(next) => form.set({ copy_to: chosen(copy, next as Choice) })}
          options={choices.map((c) => ({ value: c, label: t(`admin.backups.copyTo.${c || "none"}`) }))}
          className="max-w-xs"
        />
      </FormField>
      {copy.kind === "folder" && (
        <TextField
          label={t("admin.backups.folder")}
          value={copy.folder}
          onChange={(folder) => setCopy({ folder })}
          hint={t("admin.backups.folderHint")}
          placeholder="/mnt/backups"
          error={form.errors.fields.folder}
          mono
        />
      )}
      {copy.kind === "bucket" && (
        <BucketFields
          value={copy.bucket}
          stored={stored.bucket}
          onChange={(next) => setCopy({ bucket: { ...copy.bucket, ...next } })}
          errors={form.errors.fields}
        />
      )}
    </SettingForm>
  );
}

/** Whether a finished backup's copy got there; nothing when none was asked for. */
function CopyBadge({ backup }: { backup: Backup }) {
  if (backup.copy_error)
    return (
      <Badge tone="danger" title={backup.copy_error}>
        {t("admin.backups.notCopied")}
      </Badge>
    );
  if (backup.copied_at)
    return (
      <Badge tone="ok" title={exact(backup.copied_at)}>
        {t("admin.backups.copied")}
      </Badge>
    );
  return null;
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
        backup.error ? (
          <span className="text-danger">{backup.error}</span>
        ) : backup.copy_error ? (
          <span className="text-danger">{t("admin.backups.notCopiedWhy", { why: backup.copy_error })}</span>
        ) : (
          <span className="font-mono">{file}</span>
        )
      }
      meta={
        <>
          {!backup.error && !running && <span className="tnum max-sm:hidden">{fileSize(backup.size)}</span>}
          {!backup.error && !running && <CopyBadge backup={backup} />}
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
  const list = useQuery({
    queryKey: adminKeys.backups,
    queryFn: ({ signal }) => api.get<BackupList>("/api/v1/admin/backups", signal),
  });
  const backUp = useMutation({
    mutationFn: () => api.post<Backup>("/api/v1/admin/backups"),
    onSuccess: () => toast.info(t("admin.backups.done")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminKeys.backups }),
  });
  const [restoring, setRestoring] = useState<Backup | null>(null);

  return (
    <Page title={t("admin.backups.title")} lead={t("admin.backups.lead")} back="/admin">
      <Section title={t("admin.backups.schedule")}>
        <ScheduleForm />
      </Section>

      <Section
        title={t("admin.backups.list")}
        lead={list.data ? t("admin.backups.directory", { dir: list.data.directory }) : undefined}
        actions={
          <Button variant="primary" disabled={backUp.isPending} onClick={() => backUp.mutate()}>
            {backUp.isPending ? t("admin.backups.nowBusy") : t("admin.backups.now")}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <FormAlert>{backUp.error ? errorMessage(backUp.error) : ""}</FormAlert>
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
