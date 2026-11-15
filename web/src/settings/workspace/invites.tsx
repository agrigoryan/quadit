import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link2, Mail, UserPlus } from "lucide-react";
import { api, workspacePath } from "@/lib/api";
import { t } from "@/lib/i18n";
import { dayAndMonth } from "@/lib/time";
import { useLookupEvenIfGone, useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import type { Role } from "@/lib/types";
import { Fact } from "@/ui/fact";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { RevealDialog } from "@/ui/reveal-dialog";
import { FormAlert } from "@/ui/form";
import { EmptyRow, Row, Rows, Section } from "@/ui/page-layout";
import { inWorkspace, queryClient, readError } from "@/lib/query";
import { AddPeopleDialog } from "@/settings/workspace/add-people";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

export interface Invite {
  id: string;
  email?: string;
  role: Role;
  created_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
}

export interface Created {
  invite: Invite;
  link: string;
  mailed: boolean;
}

/** Invitations that are still good, and the way to make one. */
export function InvitesSection() {
  const slug = useSlug();
  const members = useLookupEvenIfGone("members");
  const key = [...inWorkspace(slug), "invites"];
  const invites = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get<{ invites: Invite[] }>(workspacePath(slug, "/invites"), signal).then((r) => r.invites),
  });
  const changed = () => queryClient.invalidateQueries({ queryKey: key });
  const revoking = useMutation({
    mutationFn: (id: string) => api.del(workspacePath(slug, `/invites/${id}`)),
    onSettled: changed,
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [revoke, setRevoke] = useState<Invite | null>(null);

  return (
    <Section
      title={t("invites.title")}
      lead={t("invites.lead")}
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <UserPlus className="size-3.5" aria-hidden />
          {t("invites.new")}
        </Button>
      }
    >
      {readError(invites.error) && <FormAlert>{readError(invites.error)}</FormAlert>}
      {invites.data?.length === 0 && <EmptyRow>{t("invites.none")}</EmptyRow>}
      {!!invites.data?.length && (
        <Rows>
          {invites.data.map((inv) => (
            <Row
              key={inv.id}
              lead={
                <span className="flex size-8 items-center justify-center rounded-full bg-sunken text-ink-2">
                  {inv.email ? <Mail className="size-4" /> : <Link2 className="size-4" />}
                </span>
              }
              title={inv.email || t("invites.anyone")}
              sub={
                <>
                  {t("invites.by", { name: members[inv.created_by]?.name ?? t("common.someone") })} ·{" "}
                  <When ms={inv.created_at} />
                </>
              }
              meta={
                <>
                  {inv.max_uses > 1 && (
                    <span className="max-sm:hidden">{t("invites.used", { uses: inv.uses, max: inv.max_uses })}</span>
                  )}
                  <Fact label={t("invites.expiresIn")} className="max-sm:hidden">
                    {dayAndMonth(inv.expires_at)}
                  </Fact>
                  <Badge>{t(`role.${inv.role}`)}</Badge>
                </>
              }
              actions={
                <Button variant="ghost" size="sm" onClick={() => setRevoke(inv)}>
                  {t("s.revoke")}
                </Button>
              }
            />
          ))}
        </Rows>
      )}

      {creating && (
        <AddPeopleDialog
          onClose={() => setCreating(false)}
          onAdded={(name) => {
            setCreating(false);
            toast.info(t("members.added", { name }));
          }}
          onCreated={(out) => {
            setCreating(false);
            setCreated(out);
            void changed();
          }}
        />
      )}
      <RevealDialog
        open={!!created}
        onClose={() => setCreated(null)}
        title={t("invites.created")}
        warning={created?.mailed ? t("invites.mailed", { email: created.invite.email ?? "" }) : t("invites.notMailed")}
        items={created ? [{ label: t("invites.link"), value: created.link }] : []}
      />
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(open) => !open && setRevoke(null)}
        title={t("invites.revoke.title")}
        body={t("invites.revoke.body")}
        confirm={t("s.revoke")}
        onConfirm={async () => {
          if (revoke) await revoking.mutateAsync(revoke.id);
        }}
      />
    </Section>
  );
}
