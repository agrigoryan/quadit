import { useState } from "react";
import { ArrowUpRight, LogIn, Undo2 } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { loadSession, useSession } from "@/auth/session";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Fact, LoadGate } from "@/settings/ui/bits";
import { ConfirmDialog } from "@/settings/ui/dialogs";
import { EmptyRow, Page, Row, Rows, Section } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";

export interface AdminWorkspace {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  members: number;
  tasks: number;
  /** When its owner deleted it. It can be restored for 30 days from then. */
  deleted_at?: number;
}

const DAY = 24 * 3600_000;
/** How long a deleted workspace is kept before it is removed for good. */
const KEPT_DAYS = 30;

/** "Deleted 3 days ago, removed for good in 27 days". */
function deletedText(at: number): string {
  const ago = Math.max(0, Math.floor((Date.now() - at) / DAY));
  const left = Math.max(0, KEPT_DAYS - ago);
  const when = ago === 0 ? t("admin.workspaces.deletedToday") : t("admin.workspaces.deletedAgo", { n: ago });
  return `${when}, ${left === 0 ? t("admin.workspaces.goneSoon") : t("admin.workspaces.goneIn", { n: left })}`;
}

export const fetchWorkspaces = () =>
  api.get<{ workspaces: AdminWorkspace[] }>("/api/v1/admin/workspaces").then((r) => r.workspaces);

export function WorkspacesPage() {
  const list = useLoad(fetchWorkspaces, []);
  const mine = useSession((s) => s.workspaces);
  const navigate = useNavigate();
  const [joining, setJoining] = useState<AdminWorkspace | null>(null);
  const [restoring, setRestoring] = useState<AdminWorkspace | null>(null);
  const dated = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  /** Makes the install admin an admin of the workspace; the server records it where its members can see. */
  async function join(w: AdminWorkspace) {
    await api.post<{ workspace: AdminWorkspace; already_member?: boolean }>(`/api/v1/admin/workspaces/${w.id}/join`);
    // The switcher and this list both read the session's workspaces.
    await loadSession();
    void list.reload();
    toast.info(t("admin.workspaces.joined", { name: w.name }), {
      label: t("admin.workspaces.open"),
      run: () => void navigate(`/${w.slug}`),
    });
  }

  /** Brings a deleted workspace back. The server refuses (409) when another workspace took its address meanwhile. */
  async function restore(w: AdminWorkspace) {
    await api.post(`/api/v1/admin/workspaces/${w.id}/restore`);
    await loadSession();
    await list.reload();
    toast.info(t("admin.workspaces.restored", { name: w.name }));
  }

  return (
    <Page title={t("admin.workspaces.title")} lead={t("admin.workspaces.lead")} back="/admin">
      <Section>
        <LoadGate of={list}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyRow>{t("admin.workspaces.none")}</EmptyRow>
            ) : (
              <Rows>
                {rows.map((w) => {
                  const member = mine.some((m) => m.id === w.id);
                  if (w.deleted_at) {
                    return (
                      <Row
                        key={w.id}
                        className="bg-sunken/50"
                        lead={
                          <span
                            className="flex size-6 items-center justify-center rounded-sm bg-ink-3 text-2xs font-bold text-surface"
                            aria-hidden
                          >
                            {w.name.slice(0, 1).toUpperCase()}
                          </span>
                        }
                        title={
                          <span className="flex items-center gap-1.5 text-ink-2">
                            <span className="truncate">{w.name}</span>
                            <Badge>{t("admin.workspaces.deleted")}</Badge>
                          </span>
                        }
                        sub={
                          <>
                            <span className="font-mono">/{w.slug}</span> ·{" "}
                            <span title={exact(w.deleted_at)}>{deletedText(w.deleted_at)}</span>
                          </>
                        }
                        meta={
                          <span className="flex items-center gap-4 text-ink-3 max-md:hidden">
                            <span className="tnum">{t("admin.workspaces.members", { n: w.members })}</span>
                            <span className="tnum">{t("admin.workspaces.tasks", { n: w.tasks })}</span>
                          </span>
                        }
                        actions={
                          <Button size="sm" onClick={() => setRestoring(w)} className="max-sm:h-8 max-sm:px-2.5">
                            <Undo2 className="size-3" aria-hidden />
                            {t("admin.workspaces.restore")}
                          </Button>
                        }
                      />
                    );
                  }
                  return (
                    <Row
                      key={w.id}
                      lead={
                        <span
                          className="flex size-6 items-center justify-center rounded-sm bg-ink text-2xs font-bold text-surface"
                          aria-hidden
                        >
                          {w.name.slice(0, 1).toUpperCase()}
                        </span>
                      }
                      title={w.name}
                      sub={
                        <>
                          <span className="font-mono">/{w.slug}</span>
                          <span className="sm:hidden">
                            {" · "}
                            {t("admin.workspaces.members", { n: w.members })} ·{" "}
                            {t("admin.workspaces.tasks", { n: w.tasks })}
                          </span>
                        </>
                      }
                      meta={
                        <span className="flex items-center gap-4 max-sm:hidden">
                          <span className="tnum">{t("admin.workspaces.members", { n: w.members })}</span>
                          <span className="tnum">{t("admin.workspaces.tasks", { n: w.tasks })}</span>
                          <Fact label={t("admin.workspaces.created")} className="max-md:hidden">
                            <span title={exact(w.created_at)}>{dated.format(w.created_at)}</span>
                          </Fact>
                        </span>
                      }
                      actions={
                        member ? (
                          <Link
                            to={`/${w.slug}`}
                            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm font-medium text-accent-text hover:bg-hover"
                          >
                            {t("admin.workspaces.open")}
                            <ArrowUpRight className="size-3.5" aria-hidden />
                          </Link>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => setJoining(w)}
                            title={t("admin.workspaces.notMemberHint")}
                            className="max-sm:h-8 max-sm:px-2.5"
                          >
                            <LogIn className="size-3" aria-hidden />
                            {t("admin.workspaces.join")}
                          </Button>
                        )
                      }
                    />
                  );
                })}
              </Rows>
            )
          }
        </LoadGate>
      </Section>
      <ConfirmDialog
        open={!!joining}
        onOpenChange={(open) => !open && setJoining(null)}
        title={t("admin.workspaces.joinTitle", { name: joining?.name ?? "" })}
        body={t("admin.workspaces.joinBody")}
        confirm={t("admin.workspaces.join")}
        safe
        onConfirm={() => (joining ? join(joining) : undefined)}
      />
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={t("admin.workspaces.restoreTitle", { name: restoring?.name ?? "" })}
        body={t("admin.workspaces.restoreBody", { slug: restoring?.slug ?? "" })}
        confirm={t("admin.workspaces.restore")}
        safe
        onConfirm={() => (restoring ? restore(restoring) : undefined)}
      />
    </Page>
  );
}
