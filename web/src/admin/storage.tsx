import { t } from "@/lib/i18n";
import { NumberField, SecretField, SettingForm, TextField } from "@/admin/setting-form";
import { useDraft, useSetting } from "@/admin/settings";
import { Checkbox, FormField, NativeSelect, Note } from "@/settings/ui/form";
import { Page, Section } from "@/settings/ui/layout";

type Kind = "disk" | "s3" | "gcs" | "azure";

interface FilesSetting {
  kind: Kind;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
  access_key: string;
  secret_key: string;
  path_style: boolean;
  credentials: string;
  account: string;
  account_key: string;
}

const empty: FilesSetting = {
  kind: "disk",
  bucket: "",
  prefix: "",
  region: "",
  endpoint: "",
  access_key: "",
  secret_key: "",
  path_style: false,
  credentials: "",
  account: "",
  account_key: "",
};

/**
 * Only the fields its kind uses are sent. The other kinds' secrets are sent
 * empty, which tells the server to forget them (a secret left out is kept).
 */
function toValue(v: FilesSetting): FilesSetting {
  const base = {
    kind: v.kind,
    bucket: v.bucket.trim(),
    prefix: v.prefix.trim().replace(/^\/+|\/+$/g, ""),
    secret_key: "",
    credentials: "",
    account_key: "",
  };
  const out: Partial<FilesSetting> =
    v.kind === "s3"
      ? {
          ...base,
          region: v.region.trim(),
          endpoint: v.endpoint.trim(),
          access_key: v.access_key.trim(),
          secret_key: v.secret_key,
          path_style: v.path_style,
        }
      : v.kind === "gcs"
        ? { ...base, credentials: v.credentials }
        : v.kind === "azure"
          ? { ...base, account: v.account.trim(), account_key: v.account_key }
          : { ...base, bucket: "", prefix: "" };
  return out as FilesSetting;
}

function validate(v: FilesSetting): Record<string, string> {
  const wrong: Record<string, string> = {};
  if (v.kind === "disk") return wrong;
  if (!v.bucket.trim()) wrong.bucket = t("s.required");
  if (v.kind === "s3") {
    if (!v.access_key.trim()) wrong.access_key = t("s.required");
    if (!v.secret_key) wrong.secret_key = t("s.required");
    if (v.endpoint.trim() && !/^https?:\/\/\S+$/.test(v.endpoint.trim()))
      wrong.endpoint = t("admin.storage.endpointBad");
  }
  if (v.kind === "azure") {
    if (!v.account.trim()) wrong.account = t("s.required");
    if (!v.account_key) wrong.account_key = t("s.required");
  }
  return wrong;
}

export function StoragePage() {
  const stored = useSetting<FilesSetting>("files", empty).value;
  const form = useDraft<FilesSetting>("files", empty, { validate, toValue });
  const max = useDraft<number | null>("files.max_mb", null, {
    validate: (v) => (v !== null && v < 1 ? { max: t("admin.storage.maxBad") } : {}),
  });
  const d = form.draft;
  const e = form.errors.fields;
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
              onChange={(kind) => form.set({ kind: kind as Kind })}
              options={kinds}
              className="max-w-xs"
            />
          </FormField>

          {d.kind !== "disk" && (
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField
                label={d.kind === "azure" ? t("admin.storage.container") : t("admin.storage.bucket")}
                value={d.bucket}
                onChange={(bucket) => form.set({ bucket })}
                error={e.bucket}
              />
              <TextField
                label={t("admin.storage.prefix")}
                value={d.prefix}
                onChange={(prefix) => form.set({ prefix })}
                hint={t("admin.storage.prefixHint")}
                placeholder="quadit"
              />
            </div>
          )}

          {d.kind === "s3" && (
            <>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <TextField
                  label={t("admin.storage.region")}
                  value={d.region}
                  onChange={(region) => form.set({ region })}
                  placeholder="us-east-1"
                />
                <TextField
                  label={t("admin.storage.endpoint")}
                  value={d.endpoint}
                  onChange={(endpoint) => form.set({ endpoint })}
                  hint={t("admin.storage.endpointHint")}
                  placeholder="https://…"
                  error={e.endpoint}
                />
              </div>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <TextField
                  label={t("admin.storage.accessKey")}
                  value={d.access_key}
                  onChange={(access_key) => form.set({ access_key })}
                  error={e.access_key}
                  mono
                />
                <SecretField
                  label={t("admin.storage.secretKey")}
                  value={d.secret_key}
                  stored={stored.secret_key}
                  onChange={(secret_key) => form.set({ secret_key })}
                  error={e.secret_key}
                />
              </div>
              <Checkbox checked={d.path_style} onChange={(path_style) => form.set({ path_style })}>
                {t("admin.storage.pathStyle")}
              </Checkbox>
            </>
          )}

          {d.kind === "gcs" && (
            <SecretField
              multiline
              label={t("admin.storage.credentials")}
              value={d.credentials}
              stored={stored.credentials}
              onChange={(credentials) => form.set({ credentials })}
              hint={t("admin.storage.credentialsHint")}
            />
          )}

          {d.kind === "azure" && (
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField
                label={t("admin.storage.account")}
                value={d.account}
                onChange={(account) => form.set({ account })}
                error={e.account}
              />
              <SecretField
                label={t("admin.storage.accountKey")}
                value={d.account_key}
                stored={stored.account_key}
                onChange={(account_key) => form.set({ account_key })}
                error={e.account_key}
              />
            </div>
          )}

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
