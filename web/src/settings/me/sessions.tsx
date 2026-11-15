import { useEffect, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { summariseAgent } from "@/settings/me/user-agent";
import { Fact } from "@/ui/fact";
import { LoadGate } from "@/ui/load-gate";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Row, Rows, Section } from "@/ui/page-layout";
import { useLoad } from "@/lib/use-load";
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

interface Props {
  /** Changes when something else ended sessions (a new password): fetch the list again. */
  stamp: number;
}

/** Every browser signed in to the account, with a way to sign any of them out. */
export function SessionsSection({ stamp }: Props) {
  const list = useLoad(() => api.get<{ sessions: Session[] }>(SESSIONS).then((r) => r.sessions), []);
  const [ending, setEnding] = useState<Session | null>(null);
  const { reload } = list;

  useEffect(() => {
    if (stamp > 0) void reload();
  }, [stamp, reload]);

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
          await api.del(`${SESSIONS}/${ending?.id}`);
          await reload();
        }}
      />
    </Section>
  );
}
