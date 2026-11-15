import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { KeyRound, MoreHorizontal, Pencil, Plus, ScrollText, Send, Trash2 } from "lucide-react";
import { api, errorMessage, workspacePath } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useLookupEvenIfGone, useRows, useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";
import { useSettingsBase } from "@/settings/base";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { RevealDialog } from "@/ui/reveal-dialog";
import { Switch } from "@/ui/form";
import { EmptyRow, Page, Rows } from "@/ui/page-layout";
import { queryClient } from "@/lib/query";
import {
  automationKeys,
  change,
  lastSent,
  listWebhooks,
  randomSecret,
  type TestResult,
  type WebhookRow,
} from "@/settings/automation/data";
import type { Webhook } from "@/lib/types-automation";
import { DeliveriesDialog } from "@/settings/automation/deliveries";
import { EventBadges } from "@/settings/automation/event-picker";
import { WebhookForm } from "@/settings/automation/webhook-form";

type Test = { busy: true } | { busy: false; result: TestResult } | { busy: false; failed: string };

/** What the receiver said to the test, in one line. */
function TestLine({ test }: { test: Test }) {
  if (test.busy) return <p className="text-xs text-ink-3">{t("auto.hook.testing")}</p>;
  const ok = "result" in test && test.result.ok;
  let text: string;
  if ("failed" in test) text = test.failed;
  else if (test.result.status === 0) text = t("auto.hook.test.noAnswer", { error: test.result.error });
  else if (ok) text = t("auto.hook.test.ok", { status: test.result.status, ms: test.result.ms });
  else text = t("auto.hook.test.bad", { status: test.result.status, ms: test.result.ms, error: test.result.error });
  return (
    <output
      className={cx("block rounded-md px-2 py-1 text-xs", ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")}
    >
      {text}
    </output>
  );
}

interface ItemProps {
  hook: WebhookRow;
  test: Test | undefined;
  onTest: () => void;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onLog: () => void;
  onRotate: () => void;
  onDelete: () => void;
}

function WebhookItem({ hook, test, onTest, onToggle, onEdit, onLog, onRotate, onDelete }: ItemProps) {
  const projects = useLookupEvenIfGone("projects");
  const members = useLookupEvenIfGone("members");
  const project = hook.project_id ? projects[hook.project_id] : undefined;
  const member = hook.user_id ? members[hook.user_id] : undefined;
  const last = lastSent(hook);
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Switch checked={hook.active} onChange={onToggle} label={t("auto.hook.activeFor", { name: hook.name })} />
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <span className={cx("block truncate text-sm font-medium", hook.active ? "text-ink" : "text-ink-3")}>
            {hook.name}
          </span>
          <span className="block truncate font-mono text-xs text-ink-3">{hook.url}</span>
        </button>
        <Button size="sm" onClick={onTest} disabled={test?.busy}>
          <Send className="size-3" aria-hidden />
          {t("auto.hook.test")}
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={t("s.actions")}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<ScrollText />} onSelect={onLog}>
              {t("auto.hook.deliveries")}
            </MenuItem>
            <MenuItem icon={<Pencil />} onSelect={onEdit}>
              {t("common.edit")}
            </MenuItem>
            <MenuItem icon={<KeyRound />} onSelect={onRotate}>
              {t("auto.hook.newSecret")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
              {t("s.delete")}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-11 text-xs">
        {member ? (
          <Badge tone="accent">{t("auto.hook.inboxOf", { handle: member.handle })}</Badge>
        ) : (
          <>
            <EventBadges types={hook.event_types} />
            <Badge>{project ? project.key : t("s.everyProject")}</Badge>
          </>
        )}
        {hook.failures > 0 && <Badge tone="danger">{t("auto.hook.failures", { n: hook.failures })}</Badge>}
        {last ? (
          <Fact label={t("auto.hook.last")} className="max-w-full min-w-0">
            <span
              className={cx("mr-1.5 inline-block max-w-56 truncate align-bottom", last.failed && "text-danger")}
              title={last.result}
            >
              {last.result}
            </span>
            <When ms={last.at} />
            {last.test && (
              <Badge tone="accent" title={t("auto.delivery.testHint")} className="ml-1.5">
                {t("auto.delivery.test")}
              </Badge>
            )}
          </Fact>
        ) : (
          <span className="text-ink-3">{t("auto.hook.neverSent")}</span>
        )}
        <button type="button" onClick={onLog} className="text-accent-text underline-offset-2 hover:underline">
          {t("auto.hook.deliveries")}
        </button>
      </div>
      {test && (
        <div className="pl-11">
          <TestLine test={test} />
        </div>
      )}
    </div>
  );
}

/** Webhooks: addresses the workspace calls when something happens. */
export function WebhooksPage() {
  const slug = useSlug();
  const key = automationKeys.webhooks(slug);
  const [form, setForm] = useState<{ hook?: Webhook } | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);
  const [rotating, setRotating] = useState<Webhook | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});

  // What a webhook last sent is not an event, so the list is read again
  // every ten seconds while the page is in view and nothing is open over it.
  const busy = !!(form || log || removing || rotating);
  const hooks = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listWebhooks(slug, signal),
    refetchInterval: busy ? false : 10_000,
  });
  const changed = () => queryClient.invalidateQueries({ queryKey: key });

  // A webhook made or removed somewhere else is heard through the feed: read the list again (once, if a read is on its way).
  const known = useRows("webhooks");
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is a new array each render; what it names is `slug`
  }, [known, slug]);

  const testing = useMutation({
    mutationFn: (hook: Webhook) => api.post<TestResult>(workspacePath(slug, `/webhooks/${hook.id}/test`)),
    onMutate: (hook) => setTests((s) => ({ ...s, [hook.id]: { busy: true } })),
    onSuccess: (result, hook) => setTests((s) => ({ ...s, [hook.id]: { busy: false, result } })),
    onError: (err, hook) => setTests((s) => ({ ...s, [hook.id]: { busy: false, failed: errorMessage(err) } })),
    // A test is logged as a delivery: the row's "last delivery" and its list now have it.
    onSettled: changed,
  });

  async function toggle(hook: Webhook, active: boolean) {
    queryClient.setQueryData<WebhookRow[]>(key, (list) => list?.map((h) => (h.id === hook.id ? { ...h, active } : h)));
    try {
      await change("webhook.update", { id: hook.id, active });
    } catch (err) {
      toast.error(errorMessage(err));
    }
    await changed();
  }

  async function rotate(hook: Webhook) {
    const value = randomSecret();
    await change("webhook.update", { id: hook.id, secret: value });
    setSecret({ name: hook.name, value });
  }

  return (
    <Page
      title={t("settings.nav.webhooks")}
      lead={t("auto.hook.lead")}
      back={useSettingsBase()}
      actions={
        <Button variant="primary" onClick={() => setForm({})}>
          <Plus className="size-4" aria-hidden />
          {t("auto.hook.new")}
        </Button>
      }
    >
      <LoadGate of={hooks}>
        {(list) =>
          list.length === 0 ? (
            <EmptyRow>{t("auto.hook.empty")}</EmptyRow>
          ) : (
            <Rows>
              {list.map((hook) => (
                <WebhookItem
                  key={hook.id}
                  hook={hook}
                  test={tests[hook.id]}
                  onTest={() => testing.mutate(hook)}
                  onToggle={(active) => void toggle(hook, active)}
                  onEdit={() => setForm({ hook })}
                  onLog={() => setLog(hook)}
                  onRotate={() => setRotating(hook)}
                  onDelete={() => setRemoving(hook)}
                />
              ))}
            </Rows>
          )
        }
      </LoadGate>

      {form && (
        <WebhookForm
          hook={form.hook}
          onClose={() => setForm(null)}
          onSaved={(made) => {
            setForm(null);
            if (made) setSecret(made);
            void changed();
          }}
        />
      )}
      {log && (
        <DeliveriesDialog
          hook={log}
          onClose={() => {
            setLog(null);
            void changed();
          }}
        />
      )}
      <RevealDialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title={t("auto.hook.secretTitle", { name: secret?.name ?? "" })}
        warning={t("auto.hook.secretWarning")}
        items={[{ label: t("auto.hook.secret"), value: secret?.value ?? "" }]}
      >
        <p className="text-sm text-ink-2">{t("auto.hook.secretHow")}</p>
      </RevealDialog>
      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(open) => !open && setRotating(null)}
        title={t("auto.hook.newSecret")}
        body={t("auto.hook.newSecretBody", { name: rotating?.name ?? "" })}
        confirm={t("auto.hook.newSecretConfirm")}
        onConfirm={() => (rotating ? rotate(rotating) : undefined)}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("auto.hook.deleteTitle", { name: removing?.name ?? "" })}
        body={t("auto.hook.deleteBody")}
        confirm={t("s.delete")}
        onConfirm={async () => {
          if (removing) await change("webhook.delete", { id: removing.id });
          await changed();
        }}
      />
    </Page>
  );
}
