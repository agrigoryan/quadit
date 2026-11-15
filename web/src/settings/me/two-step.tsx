import { useState } from "react";
import { Download } from "lucide-react";
import { api, errorMessage } from "@/data/api";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import type { Account } from "@/settings/me/account";
import { QrCode } from "@/settings/me/qr";
import { CopyField, RevealDialog } from "@/ui/reveal-dialog";
import { FormAlert, FormField, refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Card, Section } from "@/ui/page-layout";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

const TOTP = "/api/v1/auth/totp";

/** Saves text as a file on the person's device. */
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CodeField({
  id,
  value,
  onChange,
  error,
  label,
  hint,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  label: string;
  hint?: string;
}) {
  return (
    <FormField label={label} htmlFor={id} error={error} hint={hint}>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        className="max-w-40 font-mono tracking-widest"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </FormField>
  );
}

/** Step one and two of turning it on: add the key to an app, then prove the app works. */
function SetupDialog({
  setup,
  onClose,
  onEnabled,
}: {
  setup: { secret: string; url: string };
  onClose: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const errors = useFieldErrors(["code"]);

  async function submit() {
    let out: { recovery_codes: string[] };
    try {
      out = await api.post<{ recovery_codes: string[] }>(`${TOTP}/enable`, { code: code.trim() });
    } catch (err) {
      // Whatever went wrong, the code is what to try again.
      refuse("code", errorMessage(err));
    }
    onEnabled(out.recovery_codes);
  }

  return (
    <FormDialog
      title={t("me.twoStep.setupTitle")}
      submit={t("me.twoStep.turnOn")}
      ready={code.trim().length >= 6}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("me.twoStep.step1")}</p>
        <div className="flex flex-col items-start gap-4 sm:flex-row">
          <QrCode value={setup.url} label={t("me.twoStep.qrLabel")} />
          <div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
            <p className="text-sm text-ink-2">{t("me.twoStep.step1Hint")}</p>
            <CopyField label={t("me.twoStep.secret")} value={setup.secret} />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("me.twoStep.step2")}</p>
        <CodeField
          id="totp-code"
          label={t("me.twoStep.code")}
          value={code}
          onChange={setCode}
          error={errors.fields.code}
        />
      </div>
    </FormDialog>
  );
}

/** Asks for a code (and, to turn it off, optionally the password instead) before a change to the second step. */
function ConfirmCodeDialog({
  mode,
  onClose,
  onDone,
}: {
  mode: "off" | "renew";
  onClose: () => void;
  onDone: (codes?: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const errors = useFieldErrors(["code", "password"]);
  const off = mode === "off";

  async function submit() {
    if (off) {
      await api.post(`${TOTP}/disable`, { code: code.trim(), password });
      onDone();
    } else {
      const out = await api.post<{ recovery_codes: string[] }>("/api/v1/auth/recovery-codes", { code: code.trim() });
      onDone(out.recovery_codes);
    }
  }

  return (
    <FormDialog
      title={off ? t("me.twoStep.offTitle") : t("me.twoStep.renewTitle")}
      size="sm"
      submit={off ? t("me.twoStep.turnOff") : t("me.twoStep.renew")}
      tone={off ? "danger" : "primary"}
      ready={!!code.trim() || !!password}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <p className="text-sm text-ink-2">{off ? t("me.twoStep.offBody") : t("me.twoStep.renewBody")}</p>
      <CodeField
        id="totp-confirm-code"
        label={off ? t("me.twoStep.codeOrRecovery") : t("me.twoStep.code")}
        value={code}
        onChange={setCode}
        error={errors.fields.code}
      />
      {off && (
        <FormField label={t("me.twoStep.orPassword")} htmlFor="totp-confirm-pw" error={errors.fields.password}>
          <Input
            id="totp-confirm-pw"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
      )}
    </FormDialog>
  );
}

interface Props {
  account: Account;
  /** Called when two-step verification was turned on or off. */
  onChanged: () => void;
}

export function TwoStepSection({ account, onChanged }: Props) {
  const on = !!account.user.totp_at;
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ask, setAsk] = useState<"off" | "renew" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      setSetup(await api.post<{ secret: string; url: string }>(`${TOTP}/start`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={t("me.twoStep.title")} lead={t("me.twoStep.lead")}>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Badge tone={on ? "ok" : "neutral"}>{on ? t("s.on") : t("s.off")}</Badge>
            <span className="min-w-0 text-sm text-ink-2">
              {on ? t("me.twoStep.onSince", { when: exact(account.user.totp_at as number) }) : t("me.twoStep.offHint")}
            </span>
          </div>
          {on ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setAsk("renew")}>{t("me.twoStep.renew")}</Button>
              <Button variant="danger-quiet" onClick={() => setAsk("off")}>
                {t("me.twoStep.turnOff")}
              </Button>
            </div>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void start()}>
              {t("me.twoStep.setUp")}
            </Button>
          )}
        </div>
        <FormAlert>{error}</FormAlert>
      </Card>

      {setup && (
        <SetupDialog
          setup={setup}
          onClose={() => setSetup(null)}
          onEnabled={(list) => {
            setSetup(null);
            setCodes(list);
            onChanged();
          }}
        />
      )}
      {ask && (
        <ConfirmCodeDialog
          mode={ask}
          onClose={() => setAsk(null)}
          onDone={(list) => {
            if (ask === "off") {
              toast.info(t("me.twoStep.turnedOff"));
              onChanged();
            } else if (list) {
              setCodes(list);
            }
            setAsk(null);
          }}
        />
      )}
      <RevealDialog
        open={!!codes}
        onClose={() => setCodes(null)}
        title={t("me.twoStep.codesTitle")}
        warning={t("me.twoStep.codesWarning")}
        items={[{ label: t("me.twoStep.codes"), value: (codes ?? []).join("\n"), multiline: true }]}
      >
        <div>
          <Button onClick={() => saveText("quadit-recovery-codes.txt", `${(codes ?? []).join("\n")}\n`)}>
            <Download className="size-3.5" aria-hidden />
            {t("me.twoStep.codesDownload")}
          </Button>
        </div>
      </RevealDialog>
    </Section>
  );
}
