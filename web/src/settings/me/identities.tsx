import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link2 } from "lucide-react";
import { authConfig } from "@/auth/session";
import { api } from "@/data/api";
import { t } from "@/lib/i18n";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { EmptyRow, Row, Rows, Section } from "@/ui/page-layout";
import { accountChanged, accountKeys } from "@/settings/me/account";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

interface Identity {
  id: string;
  provider: string;
  email?: string;
  created_at: number;
}

const builtIn: Record<string, string> = { google: "Google", github: "GitHub" };

/** Sends the browser to the provider; it comes back to this page with the account connected. */
function connect(provider: string) {
  const query = new URLSearchParams({ link: "1", next: window.location.pathname });
  window.location.href = `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start?${query.toString()}`;
}

/** Accounts elsewhere (Google, GitHub, single sign-on) that can sign in to this one. */
export function IdentitiesSection() {
  const data = useQuery({
    queryKey: accountKeys.identities,
    queryFn: async ({ signal }) => {
      const [config, ids] = await Promise.all([
        authConfig(),
        api.get<{ identities: Identity[] }>("/api/v1/auth/identities", signal),
      ]);
      return { providers: config.providers, identities: ids.identities };
    },
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/auth/identities/${id}`),
    onSettled: accountChanged,
  });
  const [removing, setRemoving] = useState<{ identity: Identity; name: string } | null>(null);

  return (
    <Section title={t("me.identities.title")} lead={t("me.identities.lead")}>
      <LoadGate of={data}>
        {({ providers, identities }) => {
          const nameOf = (id: string) =>
            providers.find((p) => p.id === id)?.name ?? builtIn[id] ?? t("me.identities.sso");
          const open = providers.filter((p) => !identities.some((i) => i.provider === p.id));
          if (identities.length === 0 && open.length === 0) return <EmptyRow>{t("me.identities.none")}</EmptyRow>;
          return (
            <Rows>
              {identities.map((identity) => (
                <Row
                  key={identity.id}
                  lead={<Link2 className="size-4 text-ink-3" aria-hidden />}
                  title={nameOf(identity.provider)}
                  sub={
                    <>
                      {identity.email ? `${identity.email} · ` : ""}
                      {t("me.identities.since")} <When ms={identity.created_at} />
                    </>
                  }
                  meta={<Badge tone="ok">{t("me.identities.connected")}</Badge>}
                  actions={
                    <Button variant="ghost" onClick={() => setRemoving({ identity, name: nameOf(identity.provider) })}>
                      {t("me.identities.disconnect")}
                    </Button>
                  }
                />
              ))}
              {open.map((p) => (
                <Row
                  key={p.id}
                  lead={<Link2 className="size-4 text-ink-3" aria-hidden />}
                  title={p.name}
                  sub={t("me.identities.notConnected")}
                  actions={<Button onClick={() => connect(p.id)}>{t("me.identities.connect")}</Button>}
                />
              ))}
            </Rows>
          );
        }}
      </LoadGate>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("me.identities.disconnectTitle", { name: removing?.name ?? "" })}
        body={t("me.identities.disconnectBody", { name: removing?.name ?? "" })}
        confirm={t("me.identities.disconnect")}
        onConfirm={async () => {
          if (removing) await disconnect.mutateAsync(removing.identity.id);
        }}
      />
    </Section>
  );
}
