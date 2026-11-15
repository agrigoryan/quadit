import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import { api } from "@/data/api";
import { t } from "@/lib/i18n";
import { summariseAgent } from "@/settings/me/user-agent";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Row, Rows, Section } from "@/ui/page-layout";
import { accountKeys } from "@/settings/me/account";
import { queryClient } from "@/data/query";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

interface Session {
  id: string;
  ip?: string;
  user_agent?: string;
  created_at: number;
  last_seen_at: number;
  current: boolean;
}

const SESSIONS = "/api/v1/auth/sessions";

/** Every browser signed in to the account, with a way to sign any of them out. */
export function SessionsSection() {
  const list = useQuery({
    queryKey: accountKeys.sessions,
    queryFn: ({ signal }) => api.get<{ sessions: Session[] }>(SESSIONS, signal).then((r) => r.sessions),
  });
  const end = useMutation({
    mutationFn: (id: string) => api.del(`${SESSIONS}/${id}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
  const [ending, setEnding] = useState<Session | null>(null);

  return (
    <Section title={t("me.sessions.title")} lead={t("me.sessions.lead")}>
      <LoadGate of={list}>
        {(sessions) => (
          <Rows>
            {[...sessions]
              .sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at - a.last_seen_at)
              .map((s) => (
                <Row
                  key={s.id}
                  lead={<MonitorSmartphone className="size-4 text-ink-3" aria-hidden />}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{summariseAgent(s.user_agent) || t("me.sessions.unknown")}</span>
                      {s.current && <Badge tone="accent">{t("me.sessions.current")}</Badge>}
                    </span>
                  }
                  sub={
                    <>
                      {s.ip ? `${s.ip} · ` : ""}
                      {t("me.sessions.signedIn")} <When ms={s.created_at} />
                    </>
                  }
                  meta={
                    <Fact label={t("me.sessions.lastSeen")} className="max-sm:hidden">
                      <When ms={s.last_seen_at} />
                    </Fact>
                  }
                  actions={
                    !s.current && (
                      <Button variant="ghost" onClick={() => setEnding(s)}>
                        {t("top.signOut")}
                      </Button>
                    )
                  }
                />
              ))}
          </Rows>
        )}
      </LoadGate>
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(open) => !open && setEnding(null)}
        title={t("me.sessions.endTitle")}
        body={t("me.sessions.endBody", { what: summariseAgent(ending?.user_agent) || t("me.sessions.unknown") })}
        confirm={t("top.signOut")}
        onConfirm={async () => {
          if (ending) await end.mutateAsync(ending.id);
        }}
      />
    </Section>
  );
}
