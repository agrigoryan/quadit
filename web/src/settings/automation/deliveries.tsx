import { useState } from "react";
import { RefreshCw, RotateCw } from "lucide-react";
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
import { type Delivery, listRows, type Webhook } from "@/settings/automation/data";

const tones = { pending: "wait", ok: "ok", dead: "danger" } as const;

function DeliveryRow({ d, onRedeliver }: { d: Delivery; onRedeliver: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retrying = d.state === "pending" && d.attempts > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <Badge tone={tones[d.state] ?? "neutral"} className="w-16 justify-center">
        {t(`auto.delivery.state.${d.state}`)}
      </Badge>
      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate font-mono text-xs text-ink">{d.event_type}</span>
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
      </span>
    </div>
  );
}

/** What was sent to one webhook, newest first, with a way to send any of it again. */
export function DeliveriesDialog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const slug = useSlug();
  const log = useLoad(() => listRows<Delivery>(slug, "deliveries", `?webhook=${hook.id}&limit=100`), [slug, hook.id]);

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
          <Button onClick={() => void log.reload()} disabled={log.loading} className="mr-auto">
            <RefreshCw className="size-3.5" aria-hidden />
            {t("s.refresh")}
          </Button>
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
