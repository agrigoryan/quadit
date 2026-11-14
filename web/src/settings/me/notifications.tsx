import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useSettingsBase } from "@/settings/base";
import { type Account, type EmailChoice, type NotifyPrefs, saveAccount, useAccount } from "@/settings/me/account";
import { type PushState, pushState, sendTestPush, turnPushOff, turnPushOn } from "@/settings/me/push";
import { LoadGate } from "@/settings/ui/bits";
import { FormAlert, Note, SwitchRow } from "@/settings/ui/form";
import { Card, Page, Rows, Section } from "@/settings/ui/layout";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

const emailChoices: EmailChoice[] = ["all", "important", "none"];

/** Both fields are always sent, so changing one never forgets the other. */
const prefsOf = (a: Account): Required<NotifyPrefs> => ({ email: a.user.notify?.email ?? "important", push: a.user.notify?.push ?? true });

function useSavePrefs(account: Account, onSaved: (a: Account) => void) {
  const [error, setError] = useState("");
  const save = async (change: NotifyPrefs) => {
    setError("");
    const before = account;
    const notify = { ...prefsOf(account), ...change };
    // Show the choice at once; put it back if the server refuses.
    onSaved({ ...account, user: { ...account.user, notify } });
    try {
      onSaved(await saveAccount({ notify }));
    } catch (err) {
      onSaved(before);
      setError(errorMessage(err));
    }
  };
  return { save, error };
}

function EmailSection({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const { save, error } = useSavePrefs(account, onSaved);
  const value = prefsOf(account).email;
  return (
    <Section title={t("me.notify.email")} lead={t("me.notify.emailLead", { email: account.user.email ?? "" })}>
      <div className="flex flex-col gap-2.5">
        <Rows>
          <div role="radiogroup" aria-label={t("me.notify.email")} className="divide-y divide-line">
            {emailChoices.map((choice) => (
              <label key={choice} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover/60">
                <input
                  type="radio"
                  name="notify-email"
                  className="size-3.5 shrink-0 accent-accent"
                  checked={value === choice}
                  onChange={() => void save({ email: choice })}
                />
                <span className="min-w-0">
                  <span className={cx("block text-sm text-ink", value === choice && "font-medium")}>{t(`me.notify.email.${choice}`)}</span>
                  <span className="block text-xs text-ink-3">{t(`me.notify.email.${choice}Hint`)}</span>
                </span>
              </label>
            ))}
          </div>
        </Rows>
        <FormAlert>{error}</FormAlert>
      </div>
    </Section>
  );
}

const stateTone: Record<PushState, "ok" | "neutral" | "danger" | "wait"> = { on: "ok", off: "neutral", blocked: "danger", unsupported: "wait" };

function PushSection({ account, onSaved }: { account: Account; onSaved: (a: Account) => void }) {
  const { save, error: saveError } = useSavePrefs(account, onSaved);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wanted = prefsOf(account).push;

  useEffect(() => {
    let live = true;
    pushState()
      .then((s) => live && setState(s))
      .catch(() => live && setState("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  async function run(action: () => Promise<PushState>) {
    setBusy(true);
    setError("");
    try {
      setState(await action());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError("");
    try {
      toast.info(t("me.notify.testSent", { n: await sendTestPush() }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={t("me.notify.push")} lead={t("me.notify.pushLead")}>
      <Card className="flex flex-col gap-3.5">
        <SwitchRow title={t("me.notify.pushAll")} hint={t("me.notify.pushAllHint")} checked={wanted} onChange={(push) => void save({ push })} />
        <div className="border-t border-line pt-3.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                {t("me.notify.device")}
                {state && <Badge tone={stateTone[state]}>{t(`me.notify.state.${state}`)}</Badge>}
              </p>
              <p className="mt-0.5 max-w-prose text-xs text-ink-3">{state ? t(`me.notify.state.${state}Hint`) : t("common.loading")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {state === "on" && (
                <>
                  <Button disabled={busy} onClick={() => void test()}>
                    {t("me.notify.test")}
                  </Button>
                  <Button disabled={busy} onClick={() => void run(turnPushOff)}>
                    {t("me.notify.turnOff")}
                  </Button>
                </>
              )}
              {state === "off" && (
                <Button variant="primary" disabled={busy} onClick={() => void run(turnPushOn)}>
                  {t("me.notify.turnOn")}
                </Button>
              )}
            </div>
          </div>
        </div>
        {state === "on" && !wanted && <Note tone="wait">{t("me.notify.pushPaused")}</Note>}
        <FormAlert>{error || saveError}</FormAlert>
      </Card>
    </Section>
  );
}

/** Me → Notifications: how much mail, and push on this device. The inbox always gets everything. */
export function NotificationsPage() {
  const base = useSettingsBase();
  const account = useAccount();
  return (
    <Page title={t("settings.nav.notifications")} lead={t("me.notify.lead")} back={base}>
      <LoadGate of={account}>
        {(a) => (
          <>
            <EmailSection account={a} onSaved={account.set} />
            <PushSection account={a} onSaved={account.set} />
          </>
        )}
      </LoadGate>
    </Page>
  );
}
