import { t } from "@/lib/i18n";
import { SettingForm, TextField } from "@/admin/setting-form";
import { SettingSwitch } from "@/admin/setting-switch";
import { useDraft } from "@/admin/settings";
import { Page, Rows, Section } from "@/settings/ui/layout";

export function GeneralPage() {
  const name = useDraft<string>("install.name", "Quadit", {
    validate: (v) => (v.trim() ? {} : { name: t("s.required") }),
    toValue: (v) => v.trim(),
  });
  const metrics = useDraft<string>("metrics.token", "", { toValue: (v) => v.trim() });

  return (
    <Page title={t("admin.general.title")} lead={t("admin.general.lead")} back="/admin">
      <Section>
        <SettingForm of={name}>
          <TextField
            label={t("admin.general.name")}
            value={name.draft}
            onChange={name.set}
            error={name.errors.fields.name}
            hint={t("admin.general.nameHint")}
            className="max-w-sm"
          />
        </SettingForm>
      </Section>

      <Section title={t("admin.general.workspaces")}>
        <Rows>
          <SettingSwitch
            name="workspaces.anyone_can_create"
            fallback={true}
            title={t("admin.general.anyoneCreates")}
            hint={t("admin.general.anyoneCreatesHint")}
          />
        </Rows>
      </Section>

      <Section title={t("admin.general.metrics")} lead={t("admin.general.metricsLead")}>
        <SettingForm of={metrics}>
          <TextField
            label={t("admin.general.metricsToken")}
            value={metrics.draft}
            onChange={metrics.set}
            hint={t("admin.general.metricsHint")}
            mono
            className="max-w-md"
          />
        </SettingForm>
      </Section>
    </Page>
  );
}
