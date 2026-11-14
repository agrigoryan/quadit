import { t } from "@/lib/i18n";
import { NumberField, SettingForm } from "@/admin/setting-form";
import { useDraft } from "@/admin/settings";
import { Page, Section } from "@/settings/ui/layout";

export function LimitsPage() {
  // Empty means "the default": the server then counts 1200 a minute.
  const rate = useDraft<number | null>("limits.api_per_minute", null, {
    validate: (v) => (v !== null && v < 10 ? { rate: t("admin.limits.tooLow") } : {}),
  });
  return (
    <Page title={t("admin.limits.title")} lead={t("admin.limits.lead")} back="/admin">
      <Section>
        <SettingForm of={rate}>
          <NumberField
            label={t("admin.limits.rate")}
            value={rate.draft ?? undefined}
            onChange={(n) => rate.set(n ?? null)}
            min={10}
            placeholder="1200"
            unit={t("admin.limits.perMinute")}
            hint={t("admin.limits.rateHint")}
            error={rate.errors.fields.rate}
          />
        </SettingForm>
      </Section>
    </Page>
  );
}
