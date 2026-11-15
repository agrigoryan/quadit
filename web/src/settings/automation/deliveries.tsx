import { useState } from "react";
import { RefreshCw, RotateCw, Send } from "lucide-react";
import { api, errorMessage, ws } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { LoadGate, When } from "@/settings/ui/bits";
import { EmptyRow, Rows } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";
import { type Delivery, isTest, listRows, type Webhook } from "@/settings/automation/data";

const tones = { pending: "wait", ok: "ok", dead: "danger" } as const;

function DeliveryRow({ d, onRedeliver }: { d: Delivery; onRedeliver: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retrying = d.state === "pending" && d.attempts > 0;
  const test = isTest(d);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <Badge tone={tones[d.state] ?? "neutral"} className="w-16 justify-center">
        {t(`auto.delivery.state.${d.state}`)}
      </Badge>
      <span className="min-w-0 flex-1 basis-40">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-xs text-ink">{d.event_type}</span>
          {test ? (
            <Badge tone="accent" title={t("auto.delivery.testHint")}>
              {t("auto.delivery.test")}
            </Badge>
          ) : (
            <span className="shrink-0 text-xs text-ink-3 tnum" title={t("auto.delivery.seqHint")}>
              #{d.seq}
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-ink-3" title={d.error || undefined}>
          {d.error
            ? retrying
              ? t("auto.delivery.willRetry", { error: d.error })
              : d.error
            : d.status_code
              ? t("auto.delivery.answered", { status: d.status_code, ms: d.duration_ms ?? 0 })
              : t("auto.delivery.waiting")}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3 text-xs text-ink-2">
        <span className="tnum">{t("auto.delivery.attempts", { n: d.attempts })}</span>
        <When ms={d.done_at || d.created_at} />
        {/* A test is sent again with the Test button; the server does not redeliver one. */}
        {!test && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onRedeliver().finally(() => setBusy(false));
            }}
          >
            <RotateCw className="size-3" aria-hidden />
            {t("auto.delivery.redeliver")}
          </Button>
        )}
      </span>
    </div>
  );
}

/** What was sent to one webhook, newest first, with a way to send any of it again. */
export function DeliveriesDialog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const slug = useSlug();
  const log = useLoad(() => listRows<Delivery>(slug, "deliveries", `?webhook=${hook.id}&limit=100`), [slug, hook.id]);
  const [testing, setTesting] = useState(false);

  /** Sends a sample event; it is logged like any delivery, so the list shows how it went. */
  async function sendTest() {
    setTesting(true);
    try {
      await api.post(ws(slug, `/webhooks/${hook.id}/test`));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
    await log.reload();
  }

  async function redeliver(id: string) {
    try {
      await api.post(ws(slug, `/deliveries/${id}/redeliver`));
      toast.info(t("auto.delivery.queued"));
      // The sender picks it up within a couple of seconds.
      setTimeout(() => void log.reload(), 2500);
    } catch (err) {
      toast.error(errorMessage(err));
    }
    await log.reload();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("auto.delivery.title", { name: hook.name })}
      description={t("auto.delivery.lead")}
      size="lg"
      footer={
        <>
          <span className="mr-auto flex items-center gap-2">
            <Button onClick={() => void log.reload()} disabled={log.loading}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t("s.refresh")}
            </Button>
            <Button onClick={() => void sendTest()} disabled={testing}>
              <Send className="size-3.5" aria-hidden />
              {t("auto.hook.sendTest")}
            </Button>
          </span>
          <Button variant="primary" onClick={onClose}>
            {t("s.done")}
          </Button>
        </>
      }
    >
      <LoadGate of={log}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyRow>{hook.user_id ? t("auto.delivery.emptyInbox") : t("auto.delivery.empty")}</EmptyRow>
          ) : (
            <Rows>
              {rows.map((d) => (
                <DeliveryRow key={d.id} d={d} onRedeliver={() => redeliver(d.id)} />
              ))}
            </Rows>
          )
        }
      </LoadGate>
    </Dialog>
  );
}
