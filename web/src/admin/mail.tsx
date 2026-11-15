import { useState } from "react";
import { useSession } from "@/auth/session";
import { api, errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { NumberField, SecretField, SettingForm, TextField } from "@/admin/setting-form";
import { useDraft, useSetting } from "@/admin/settings";
import { FormField, NativeSelect, Note } from "@/ui/form";
import { Card, Page, Section } from "@/ui/page-layout";

interface MailSetting {
  host: string;
  port?: number;
  username: string;
  password: string;
  from: string;
  tls: string;
}

const empty: MailSetting = { host: "", username: "", password: "", from: "", tls: "starttls" };

/** Sends a test message through whatever is saved, and shows what the mail server said. */
function TestMail() {
  const me = useSession((s) => s.user?.email ?? "");
  const [to, setTo] = useState(me);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const out = await api.post<{ sent_to: string }>("/api/v1/admin/mail/test", { to: to.trim() });
      setResult({ ok: true, text: t("admin.mail.testSent", { to: out.sent_to }) });
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <FormField label={t("admin.mail.testTo")} htmlFor="mail-test-to" hint={t("admin.mail.testHint")}>
        <span className="flex max-w-md gap-2">
          <Input id="mail-test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" />
          <Button onClick={() => void send()} disabled={busy} className="h-8">
            {busy ? t("admin.mail.testBusy") : t("admin.mail.test")}
          </Button>
        </span>
      </FormField>
      {result &&
        (result.ok ? (
          <Note tone="ok">{result.text}</Note>
        ) : (
          <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-2 text-sm break-words text-danger">
            {result.text}
          </p>
        ))}
    </Card>
  );
}

export function MailPage() {
  const stored = useSetting<MailSetting>("mail", empty).value;
  const form = useDraft<MailSetting>("mail", empty, {
    validate: (v) => {
      const wrong: Record<string, string> = {};
      if (v.host.trim() && !v.from.trim()) wrong.from = t("admin.mail.needFrom");
      if (v.port !== undefined && (v.port < 1 || v.port > 65535)) wrong.port = t("admin.mail.portBad");
      return wrong;
    },
    toValue: (v) => ({
      ...v,
      host: v.host.trim(),
      username: v.username.trim(),
      from: v.from.trim(),
      port: v.port || undefined,
    }),
  });
  const d = form.draft;
  const e = form.errors.fields;
  const ready = !!stored.host && !!stored.from;

  return (
    <Page title={t("admin.mail.title")} lead={t("admin.mail.lead")} back="/admin">
      <Section title={t("admin.mail.server")}>
        <div className="flex flex-col gap-3">
          {!ready && <Note tone="wait">{t("admin.mail.notReady")}</Note>}
          <SettingForm of={form}>
            <div className="grid gap-3.5 sm:grid-cols-[1fr_auto]">
              <TextField
                label={t("admin.mail.host")}
                value={d.host}
                onChange={(host) => form.set({ host })}
                placeholder="smtp.example.com"
              />
              <NumberField
                label={t("admin.mail.port")}
                value={d.port || undefined}
                onChange={(port) => form.set({ port })}
                placeholder={d.tls === "tls" ? "465" : "587"}
                min={1}
                max={65535}
                error={e.port}
              />
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField
                label={t("admin.mail.username")}
                value={d.username}
                onChange={(username) => form.set({ username })}
              />
              <SecretField
                label={t("admin.mail.password")}
                value={d.password}
                stored={stored.password}
                onChange={(password) => form.set({ password })}
              />
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField
                label={t("admin.mail.from")}
                value={d.from}
                onChange={(from) => form.set({ from })}
                placeholder="Quadit <quadit@example.com>"
                hint={t("admin.mail.fromHint")}
                error={e.from}
              />
              <FormField label={t("admin.mail.tls")} htmlFor="mail-tls" hint={t("admin.mail.tlsHint")}>
                <NativeSelect
                  id="mail-tls"
                  value={d.tls || "starttls"}
                  onChange={(tls) => form.set({ tls })}
                  options={[
                    { value: "starttls", label: t("admin.mail.tls.starttls") },
                    { value: "tls", label: t("admin.mail.tls.tls") },
                    { value: "none", label: t("admin.mail.tls.none") },
                  ]}
                />
              </FormField>
            </div>
          </SettingForm>
        </div>
      </Section>

      <Section title={t("admin.mail.testTitle")} lead={t("admin.mail.testLead")}>
        <TestMail />
      </Section>
    </Page>
  );
}
