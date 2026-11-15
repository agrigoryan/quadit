// Shared resources (a build machine, a test device) as queues: who holds
// each one and until when, and who waits behind them, in order. An admin can
// release a hold, take someone out of a queue, and add or remove resources.

import { useState } from "react";
import { Ellipsis, Plus, Server, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate, send } from "@/data/mutate";
import { useCan } from "@/data/access";
import { useMember, useRowEvenIfGone } from "@/data/selectors";
import { ago, exact, timeOfDay } from "@/lib/time";
import { nameOf } from "@/detail/data";
import type { Claim, Resource } from "@/types/agents";
import { Panel } from "@/insights/ui/panel";
import { useTaskLink } from "@/lib/task-link";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { FormField, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Input, Textarea } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";

function release(claim: Claim) {
  send({ type: "resource.release", args: { resource: claim.resource_id, user: claim.user_id } }, (tx) =>
    tx.patch("claims", claim.id, { state: "released", released_at: Date.now() }),
  );
}

function ClaimTask({ taskId }: { taskId: string }) {
  // A claim names its task even after the task is archived or trashed.
  const task = useRowEvenIfGone("tasks", taskId);
  const link = useTaskLink({ key: task?.key ?? "" });
  if (!task) return null;
  return (
    <Link
      {...link}
      title={task.title}
      className="shrink-0 text-xs text-ink-3 tnum underline-offset-2 hover:text-ink hover:underline"
    >
      {task.key}
    </Link>
  );
}

/** One place in the queue: the holder, or someone waiting with their position. */
interface ClaimRowProps {
  claim: Claim;
  /** The resource's name, for the button's spoken label. */
  resource: string;
  place: number;
  now: number;
  canRelease: boolean;
}

function ClaimRow({ claim, resource, place, now, canRelease }: ClaimRowProps) {
  const member = useMember(claim.user_id);
  const holding = claim.state === "holding";
  const until = claim.lease_until ?? 0;
  const name = nameOf(member);
  return (
    <li className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-sm">
      <span className="w-4 shrink-0 text-center text-xs text-ink-3 tnum" aria-hidden>
        {holding ? "" : place}
      </span>
      <Avatar member={member} size="sm" />
      <span className="min-w-0 truncate font-medium">{name}</span>
      {claim.note && (
        <span className="min-w-0 flex-1 basis-24 truncate text-ink-2" title={claim.note}>
          {claim.note}
        </span>
      )}
      {!claim.note && <span className="flex-1" />}
      {claim.task_id && <ClaimTask taskId={claim.task_id} />}
      <span className="shrink-0 text-xs text-ink-3 tnum" title={exact(holding ? until : claim.requested_at)}>
        {holding
          ? until < now
            ? t("agents.res.ranOut", { time: timeOfDay(until) })
            : t("agents.res.until", { time: timeOfDay(until) })
          : t("agents.res.asked", { when: ago(claim.requested_at, now) })}
      </span>
      {canRelease && (
        <Button
          size="sm"
          className="max-md:h-8"
          onClick={() => release(claim)}
          aria-label={t(holding ? "agents.res.releaseOf" : "agents.res.removeOf", { name, resource })}
        >
          {t(holding ? "agents.res.release" : "agents.res.remove")}
        </Button>
      )}
    </li>
  );
}

function ResourceCard({
  resource,
  claims,
  now,
  admin,
  onDelete,
}: {
  resource: Resource;
  claims: Claim[];
  now: number;
  admin: boolean;
  onDelete: () => void;
}) {
  const can = useCan();
  const holder = claims.find((c) => c.state === "holding");
  const waiting = claims.filter((c) => c.state === "waiting");
  return (
    <article
      aria-label={resource.name}
      className="flex min-w-0 flex-col border-b border-line bg-surface px-4 py-3 lg:border-r"
    >
      <header className="flex min-w-0 items-center gap-2">
        <Server className="size-4 shrink-0 text-ink-3" aria-hidden />
        <h3 className="min-w-0 truncate text-sm font-semibold">{resource.name}</h3>
        {holder ? (
          <Badge tone="accent">{t("agents.res.inUse")}</Badge>
        ) : (
          <Badge tone="ok">{t("agents.res.free")}</Badge>
        )}
        {waiting.length > 0 && (
          <span className="shrink-0 text-xs text-ink-3">{t("agents.res.waitingCount", { n: waiting.length })}</span>
        )}
        <span className="flex-1" />
        {admin && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={t("agents.res.more", { name: resource.name })} size="sm" className="max-md:size-8">
                <Ellipsis className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
                {t("agents.res.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </header>
      {resource.description && <p className="mt-0.5 pl-6 text-xs text-ink-2">{resource.description}</p>}
      {claims.length === 0 ? (
        <p className="mt-1.5 pl-6 text-sm text-ink-3">{t("agents.res.nobody")}</p>
      ) : (
        <ol className="mt-1.5 flex flex-col" aria-label={t("agents.res.queueOf", { name: resource.name })}>
          {holder && (
            <ClaimRow
              claim={holder}
              resource={resource.name}
              place={0}
              now={now}
              canRelease={can.editMadeBy(holder.user_id)}
            />
          )}
          {waiting.map((claim, i) => (
            <ClaimRow
              key={claim.id}
              claim={claim}
              resource={resource.name}
              place={i + 1}
              now={now}
              canRelease={can.editMadeBy(claim.user_id)}
            />
          ))}
        </ol>
      )}
    </article>
  );
}

/** Mount it only while it is open, so each opening starts empty. */
function AddResource({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const errors = useFieldErrors(["name", "description"]);

  async function submit() {
    const id = newId();
    const fields = { name: name.trim(), description: description.trim() };
    await mutate(
      { type: "resource.create", args: { id, ...fields } },
      (tx) => tx.insert("resources", { id, name: fields.name, description: fields.description || undefined }),
      // A name already in use is refused: the dialog says so and stays.
      { quiet: true },
    );
  }

  return (
    <FormDialog
      title={t("agents.res.addTitle")}
      description={t("agents.res.addLead")}
      size="sm"
      submit={t("agents.res.add")}
      ready={!!name.trim()}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField
        label={t("agents.res.name")}
        htmlFor="resource-name"
        hint={t("agents.res.nameHint")}
        error={errors.fields.name}
      >
        <Input
          id="resource-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          autoComplete="off"
          required
        />
      </FormField>
      <FormField label={t("agents.res.description")} htmlFor="resource-description" error={errors.fields.description}>
        <Textarea
          id="resource-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={300}
        />
      </FormField>
    </FormDialog>
  );
}

function ConfirmDelete({
  resource,
  claims,
  onClose,
}: {
  resource: Resource | null;
  claims: number;
  onClose: () => void;
}) {
  function remove() {
    if (!resource) return;
    send({ type: "resource.delete", args: { id: resource.id } }, (tx) =>
      tx.patch("resources", resource.id, { deleted_at: Date.now() }),
    );
    onClose();
  }
  return (
    <Dialog
      open={resource !== null}
      onOpenChange={(next) => !next && onClose()}
      title={t("agents.res.deleteTitle", { name: resource?.name ?? "" })}
      description={claims > 0 ? t("agents.res.deleteLeadBusy", { n: claims }) : t("agents.res.deleteLead")}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" onClick={remove}>
            {t("agents.res.delete")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

interface Props {
  resources: Resource[];
  /** Live claims in queue order. */
  claims: Claim[];
  now: number;
}

export function Resources({ resources, claims, now }: Props) {
  const admin = useCan().administer;
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Resource | null>(null);
  const of = (id: string) => claims.filter((c) => c.resource_id === id);

  return (
    <Panel
      title={t("agents.res.title")}
      meta={<span className="text-xs text-ink-3 max-sm:hidden">{t("agents.res.lead")}</span>}
      flush
      action={
        admin && (
          <Button size="sm" className="max-md:h-8" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden />
            {t("agents.res.add")}
          </Button>
        )
      }
    >
      {resources.length === 0 ? (
        <p className="px-4 py-1 text-sm text-ink-2">{admin ? t("agents.res.empty") : t("agents.res.emptyMember")}</p>
      ) : (
        <div className="grid border-t border-line lg:grid-cols-2">
          {resources.map((r) => (
            <ResourceCard
              key={r.id}
              resource={r}
              claims={of(r.id)}
              now={now}
              admin={admin}
              onDelete={() => setDeleting(r)}
            />
          ))}
        </div>
      )}
      {adding && <AddResource onClose={() => setAdding(false)} />}
      <ConfirmDelete
        resource={deleting}
        claims={deleting ? of(deleting.id).length : 0}
        onClose={() => setDeleting(null)}
      />
    </Panel>
  );
}
