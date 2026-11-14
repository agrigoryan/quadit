import { useMemo, useState } from "react";
import { Ellipsis, Search, ShieldCheck, ShieldOff, UserCheck, UserX } from "lucide-react";
import { loadSession, useSession } from "@/auth/session";
import { api } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/button";
import { Input } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { LoadGate, When } from "@/settings/ui/bits";
import { ConfirmDialog } from "@/settings/ui/dialogs";
import { EmptyRow, Page, Row, Rows, Section } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";

export interface AdminUser {
  id: string;
  kind: "person" | "agent";
  name: string;
  email?: string;
  avatar?: string;
  description?: string;
  is_admin?: boolean;
  workspace_id?: string;
  created_at: number;
  last_seen_at?: number;
  disabled_at?: number;
}

export const fetchUsers = () => api.get<{ users: AdminUser[] }>("/api/v1/admin/users").then((r) => r.users);

type Kind = "all" | "person" | "agent";
type Action = "disable" | "enable" | "admin" | "unadmin";

const patches: Record<Action, { disabled?: boolean; is_admin?: boolean }> = {
  disable: { disabled: true },
  enable: { disabled: false },
  admin: { is_admin: true },
  unadmin: { is_admin: false },
};

function KindTabs({ value, onChange, counts }: { value: Kind; onChange: (k: Kind) => void; counts: Record<Kind, number> }) {
  const kinds: Kind[] = ["all", "person", "agent"];
  return (
    <div role="tablist" aria-label={t("admin.users.kind")} className="inline-flex rounded-md border border-line-strong bg-surface p-0.5">
      {kinds.map((kind) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={value === kind}
          onClick={() => onChange(kind)}
          className={cx("h-7 rounded-sm px-2 text-sm", value === kind ? "bg-press font-medium text-ink" : "text-ink-2 hover:text-ink")}
        >
          {t(`admin.users.kind.${kind}`)} <span className="text-ink-3 tnum">{counts[kind]}</span>
        </button>
      ))}
    </div>
  );
}

export function UsersPage() {
  const me = useSession((s) => s.user?.id);
  const users = useLoad(fetchUsers, []);
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<{ user: AdminUser; action: Action } | null>(null);

  const all = users.data;
  const counts = useMemo(
    () => ({ all: all?.length ?? 0, person: all?.filter((u) => u.kind === "person").length ?? 0, agent: all?.filter((u) => u.kind === "agent").length ?? 0 }),
    [all],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (all ?? []).filter(
      (u) => (kind === "all" || u.kind === kind) && (!needle || u.name.toLowerCase().includes(needle) || (u.email ?? "").toLowerCase().includes(needle)),
    );
  }, [all, kind, q]);

  async function apply() {
    if (!pending) return;
    await api.patch<AdminUser>(`/api/v1/admin/users/${pending.user.id}`, patches[pending.action]);
    // The answer to "enable" still carries the old disabled_at, so read the list again.
    await users.reload();
    // Giving up your own admin rights changes what this browser may open.
    if (pending.user.id === me) await loadSession();
  }

  const name = pending?.user.name ?? "";
  return (
    <Page title={t("admin.users.title")} lead={t("admin.users.lead")} back="/admin" wide>
      <Section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <KindTabs value={kind} onChange={setKind} counts={counts} />
          <span className="relative min-w-40 flex-1 sm:max-w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.users.search")} aria-label={t("admin.users.search")} className="pl-8" />
          </span>
        </div>
        <LoadGate of={users}>
          {() =>
            shown.length === 0 ? (
              <EmptyRow>{t("admin.users.none")}</EmptyRow>
            ) : (
              <Rows>
                {shown.map((u) => (
                  <Row
                    key={u.id}
                    className={u.disabled_at ? "opacity-70" : undefined}
                    lead={<Avatar member={{ user_id: u.id, name: u.name, kind: u.kind, avatar: u.avatar }} size="md" />}
                    title={
                      <>
                        {u.name}
                        {u.id === me && <span className="ml-1.5 font-normal text-ink-3">({t("common.you")})</span>}
                      </>
                    }
                    sub={u.kind === "person" ? u.email : u.description || t("common.agent")}
                    meta={
                      <>
                        {u.is_admin && <Badge tone="accent">{t("admin.users.admin")}</Badge>}
                        {u.disabled_at ? <Badge tone="danger">{t("admin.users.disabled")}</Badge> : null}
                        <span className="w-16 text-right max-sm:hidden" title={t("admin.users.lastSeen")}>
                          <When ms={u.last_seen_at} />
                        </span>
                      </>
                    }
                    actions={
                      <Menu>
                        <MenuTrigger asChild>
                          <IconButton label={t("admin.users.actions", { name: u.name })}>
                            <Ellipsis className="size-4" />
                          </IconButton>
                        </MenuTrigger>
                        <MenuContent align="end">
                          {u.kind === "person" &&
                            (u.is_admin ? (
                              <MenuItem icon={<ShieldOff />} onSelect={() => setPending({ user: u, action: "unadmin" })}>
                                {t("admin.users.unadmin")}
                              </MenuItem>
                            ) : (
                              <MenuItem icon={<ShieldCheck />} onSelect={() => setPending({ user: u, action: "admin" })}>
                                {t("admin.users.makeAdmin")}
                              </MenuItem>
                            ))}
                          {u.disabled_at ? (
                            <MenuItem icon={<UserCheck />} onSelect={() => setPending({ user: u, action: "enable" })}>
                              {t("admin.users.enable")}
                            </MenuItem>
                          ) : (
                            <MenuItem danger icon={<UserX />} onSelect={() => setPending({ user: u, action: "disable" })}>
                              {t("admin.users.disable")}
                            </MenuItem>
                          )}
                        </MenuContent>
                      </Menu>
                    }
                  />
                ))}
              </Rows>
            )
          }
        </LoadGate>
      </Section>

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? t(`admin.users.confirm.${pending.action}.title`, { name }) : ""}
        body={pending ? t(`admin.users.confirm.${pending.action}.body`, { name }) : undefined}
        confirm={pending ? t(`admin.users.confirm.${pending.action}.action`) : ""}
        safe={pending?.action === "enable" || pending?.action === "admin"}
        onConfirm={apply}
      />
    </Page>
  );
}
