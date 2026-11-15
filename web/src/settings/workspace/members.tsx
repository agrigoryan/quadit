import { useState } from "react";
import { MoreHorizontal, Pause, Pencil, Play, UserMinus } from "lucide-react";
import { t } from "@/lib/i18n";
import { mutate, send } from "@/lib/mutate";
import { useMe, useMembers } from "@/lib/selectors";
import type { Member, Role } from "@/lib/types";
import { useIsAdmin, useSettingsBase } from "@/settings/base";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/settings-dialogs";
import { NativeSelect } from "@/ui/form";
import { Page, Row, Rows, Section } from "@/ui/settings-layout";
import { InvitesSection } from "@/settings/workspace/invites";
import { EditMemberDialog } from "@/settings/workspace/member-dialog";
import { roleChoices } from "@/settings/workspace/roles";
import { ScopeTags } from "@/settings/workspace/scope-fields";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu";

type Ask = { kind: "edit" | "suspend" | "remove"; member: Member } | null;

/** The people of the workspace, their roles, and the invitations that are out. */
export function MembersPage() {
  const base = useSettingsBase();
  const admin = useIsAdmin();
  const me = useMe();
  const people = useMembers().filter((m) => m.kind === "person");
  const [ask, setAsk] = useState<Ask>(null);

  const setRole = (m: Member, role: Role) =>
    send({ type: "member.update", args: { id: m.user_id, role } }, (tx) => tx.patch("members", m.user_id, { role }));
  const resume = (m: Member) =>
    send({ type: "member.update", args: { id: m.user_id, suspended: false } }, (tx) =>
      tx.patch("members", m.user_id, { suspended_at: null }),
    );

  return (
    <Page title={t("members.title")} lead={t("members.lead")} back={base}>
      <Section title={t("members.people")}>
        <Rows>
          {people.map((m) => (
            <Row
              key={m.user_id}
              lead={<Avatar member={m} size="lg" />}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{m.name}</span>
                  {m.user_id === me.user_id && <Badge>{t("members.you")}</Badge>}
                  {m.suspended_at && <Badge tone="wait">{t("members.suspended")}</Badge>}
                  <ScopeTags member={m} />
                </span>
              }
              sub={`@${m.handle}${m.title ? ` · ${m.title}` : ""}`}
              meta={
                <>
                  <span className="max-sm:hidden">
                    <span className="text-ink-3">{t("members.lastSeen")} </span>
                    <When ms={m.last_seen_at} />
                  </span>
                  {admin ? (
                    <NativeSelect
                      aria-label={t("members.roleOf", { name: m.name })}
                      value={m.role}
                      onChange={(role) => setRole(m, role as Role)}
                      options={roleChoices()}
                      className="w-26"
                    />
                  ) : (
                    <Badge>{t(`role.${m.role}`)}</Badge>
                  )}
                </>
              }
              actions={
                admin && (
                  <Menu>
                    <MenuTrigger asChild>
                      <IconButton label={t("members.menu", { name: m.name })}>
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem icon={<Pencil />} onSelect={() => setAsk({ kind: "edit", member: m })}>
                        {t("members.edit")}
                      </MenuItem>
                      {m.suspended_at ? (
                        <MenuItem icon={<Play />} onSelect={() => resume(m)}>
                          {t("members.resume")}
                        </MenuItem>
                      ) : (
                        <MenuItem icon={<Pause />} onSelect={() => setAsk({ kind: "suspend", member: m })}>
                          {t("members.suspend")}
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuItem danger icon={<UserMinus />} onSelect={() => setAsk({ kind: "remove", member: m })}>
                        {t("members.remove")}
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                )
              }
            />
          ))}
        </Rows>
      </Section>

      {admin && <InvitesSection />}

      {ask?.kind === "edit" && <EditMemberDialog member={ask.member} onClose={() => setAsk(null)} />}
      <ConfirmDialog
        open={ask?.kind === "suspend"}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t("members.suspend.title", { name: ask?.member.name ?? "" })}
        body={t("members.suspend.body")}
        confirm={t("members.suspend")}
        onConfirm={() =>
          mutate({ type: "member.update", args: { id: ask?.member.user_id, suspended: true } }, undefined, {
            quiet: true,
          })
        }
      />
      <ConfirmDialog
        open={ask?.kind === "remove"}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t("members.remove.title", { name: ask?.member.name ?? "" })}
        body={t("members.remove.body")}
        confirm={t("s.remove")}
        onConfirm={() =>
          mutate({ type: "member.remove", args: { id: ask?.member.user_id } }, undefined, { quiet: true })
        }
      />
    </Page>
  );
}
