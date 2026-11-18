import { t } from "@/lib/i18n";
import { type Bucket, BucketFields, bucketErrors, bucketValue, noBucket } from "@/admin/bucket";
import { NumberField, SettingForm } from "@/admin/setting-form";
import { useDraft, useSetting } from "@/admin/settings";
import { FormField, NativeSelect, Note } from "@/ui/form";
import { Page, Section } from "@/ui/page-layout";

export function StoragePage() {
  const stored = useSetting<Bucket>("files", noBucket).value;
  const form = useDraft<Bucket>("files", noBucket, { validate: bucketErrors, toValue: bucketValue });
  const max = useDraft<number | null>("files.max_mb", null, {
    validate: (v) => (v !== null && v < 1 ? { max: t("admin.storage.maxBad") } : {}),
  });
  const d = form.draft;
  const kinds = [
    { value: "disk", label: t("admin.storage.kind.disk") },
    { value: "s3", label: t("admin.storage.kind.s3") },
    { value: "gcs", label: t("admin.storage.kind.gcs") },
    { value: "azure", label: t("admin.storage.kind.azure") },
  ];

  return (
    <Page title={t("admin.storage.title")} lead={t("admin.storage.lead")} back="/admin">
      <Section title={t("admin.storage.where")}>
        <SettingForm of={form}>
          <FormField label={t("admin.storage.kind")} htmlFor="files-kind" hint={t(`admin.storage.kindHint.${d.kind}`)}>
            <NativeSelect
              id="files-kind"
              value={d.kind}
              onChange={(kind) => form.set({ kind: kind as Bucket["kind"] })}
              options={kinds}
              className="max-w-xs"
            />
          </FormField>

          <BucketFields value={d} stored={stored} onChange={form.set} errors={form.errors.fields} />

          {d.kind !== "disk" && stored.kind === "disk" && <Note>{t("admin.storage.switchNote")}</Note>}
        </SettingForm>
      </Section>

      <Section title={t("admin.storage.uploads")}>
        <SettingForm of={max}>
          <NumberField
            label={t("admin.storage.max")}
            value={max.draft ?? undefined}
            onChange={(n) => max.set(n ?? null)}
            min={1}
            placeholder="250"
            unit="MB"
            hint={t("admin.storage.maxHint")}
            error={max.errors.fields.max}
          />
        </SettingForm>
      </Section>
    </Page>
  );
}
