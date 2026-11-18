// A cloud bucket as a setting holds it (the server's blob.Config): file
// storage is one, and so is a bucket backups are copied to. Its shape, what
// is sent of it, what the browser checks, and its fields.

import { t } from "@/lib/i18n";
import { isWebAddress } from "@/lib/url";
import { SecretField, TextField } from "@/admin/setting-form";
import { Checkbox } from "@/ui/form";

export type CloudKind = "s3" | "gcs" | "azure";

export interface Bucket {
  kind: "disk" | CloudKind;
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

export const noBucket: Bucket = {
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

export const cloudKinds: CloudKind[] = ["s3", "gcs", "azure"];

/**
 * What is sent of a bucket: only the fields its kind uses. The other kinds'
 * secrets are sent empty, which tells the server to forget them (a secret
 * left out is kept). The disk is no bucket: all of them are forgotten.
 */
export function bucketValue(v: Bucket): Bucket {
  const base = {
    kind: v.kind,
    bucket: v.bucket.trim(),
    prefix: v.prefix.trim().replace(/^\/+|\/+$/g, ""),
    secret_key: "",
    credentials: "",
    account_key: "",
  };
  const out: Partial<Bucket> =
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
  return out as Bucket;
}

/** What is missing or wrong in a bucket, by field. */
export function bucketErrors(v: Bucket): Record<string, string> {
  const wrong: Record<string, string> = {};
  if (v.kind === "disk") return wrong;
  if (!v.bucket.trim()) wrong.bucket = t("s.required");
  if (v.kind === "s3") {
    if (!v.access_key.trim()) wrong.access_key = t("s.required");
    if (!v.secret_key) wrong.secret_key = t("s.required");
    if (v.endpoint.trim() && !isWebAddress(v.endpoint)) wrong.endpoint = t("admin.storage.endpointBad");
  }
  if (v.kind === "azure") {
    if (!v.account.trim()) wrong.account = t("s.required");
    if (!v.account_key) wrong.account_key = t("s.required");
  }
  return wrong;
}

interface FieldsProps {
  value: Bucket;
  /** The bucket as the server has it: its secrets come back as the mask. */
  stored: Bucket;
  onChange: (next: Partial<Bucket>) => void;
  errors: Record<string, string | undefined>;
}

/** The fields a cloud bucket of value's kind needs. The kind itself is chosen by the form around them. */
export function BucketFields({ value: v, stored, onChange, errors: e }: FieldsProps) {
  if (v.kind === "disk") return null;
  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <TextField
          label={v.kind === "azure" ? t("admin.storage.container") : t("admin.storage.bucket")}
          value={v.bucket}
          onChange={(bucket) => onChange({ bucket })}
          error={e.bucket}
        />
        <TextField
          label={t("admin.storage.prefix")}
          value={v.prefix}
          onChange={(prefix) => onChange({ prefix })}
          hint={t("admin.storage.prefixHint")}
          placeholder="quadit"
        />
      </div>

      {v.kind === "s3" && (
        <>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField
              label={t("admin.storage.region")}
              value={v.region}
              onChange={(region) => onChange({ region })}
              placeholder="us-east-1"
            />
            <TextField
              label={t("admin.storage.endpoint")}
              value={v.endpoint}
              onChange={(endpoint) => onChange({ endpoint })}
              hint={t("admin.storage.endpointHint")}
              placeholder="https://…"
              error={e.endpoint}
            />
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField
              label={t("admin.storage.accessKey")}
              value={v.access_key}
              onChange={(access_key) => onChange({ access_key })}
              error={e.access_key}
              mono
            />
            <SecretField
              label={t("admin.storage.secretKey")}
              value={v.secret_key}
              stored={stored.secret_key}
              onChange={(secret_key) => onChange({ secret_key })}
              error={e.secret_key}
            />
          </div>
          <Checkbox checked={v.path_style} onChange={(path_style) => onChange({ path_style })}>
            {t("admin.storage.pathStyle")}
          </Checkbox>
        </>
      )}

      {v.kind === "gcs" && (
        <SecretField
          multiline
          label={t("admin.storage.credentials")}
          value={v.credentials}
          stored={stored.credentials}
          onChange={(credentials) => onChange({ credentials })}
          hint={t("admin.storage.credentialsHint")}
        />
      )}

      {v.kind === "azure" && (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label={t("admin.storage.account")}
            value={v.account}
            onChange={(account) => onChange({ account })}
            error={e.account}
          />
          <SecretField
            label={t("admin.storage.accountKey")}
            value={v.account_key}
            stored={stored.account_key}
            onChange={(account_key) => onChange({ account_key })}
            error={e.account_key}
          />
        </div>
      )}
    </>
  );
}
