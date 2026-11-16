// A small card about a member, opened from where they are named: a mention
// in a page or in Markdown, an assignee's avatar that changes nothing when
// pressed. It says who they are (a person or an agent, their role, whether
// they were removed or suspended; for an agent, who answers for it and
// whether something is listening for its work) and leads to the tasks they
// have, in the project in view.

import { type ReactElement, useId } from "react";
import { Link, useLocation } from "react-router";
import { t } from "@/lib/i18n";
import { useListening } from "@/data/listening";
import { useMember, useSlug } from "@/data/selectors";
import type { Member } from "@/types/core";
import { projectInView } from "@/nav/project-in-view";
import { emptyFilters } from "@/tasks/filters";
import { searchFromFilters } from "@/tasks/url-filters";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { ListeningDot } from "@/ui/listening-dot";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** What a control that opens the card is called: "About Ann Owner". */
export const aboutMember = (member: Pick<Member, "name">) => t("memberCard.about", { name: member.name });

interface Props {
  member: Member;
  /** The control that opens the card. It is given its name and the card's open state. */
  children: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where the focus goes when the card closes; the control that opened it when left out. */
  onCloseAutoFocus?: (e: Event) => void;
}

export function MemberCard({ member, children, open, onOpenChange, onCloseAutoFocus }: Props) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild aria-label={aboutMember(member)}>
        {children}
      </PopoverTrigger>
      <CardContent member={member} onCloseAutoFocus={onCloseAutoFocus} />
    </Popover>
  );
}

function CardContent({ member, onCloseAutoFocus }: { member: Member; onCloseAutoFocus?: (e: Event) => void }) {
  const titleId = useId();
  const agent = member.kind === "agent";
  return (
    <PopoverContent
      aria-labelledby={titleId}
      onCloseAutoFocus={onCloseAutoFocus}
      className="w-72 max-w-[calc(100vw-2rem)] p-0"
    >
      <div className="flex items-start gap-3 p-3">
        <Avatar member={member} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-semibold">
            {member.name}
          </h2>
          <p className="truncate text-xs text-ink-3">
            @{member.handle} · {t(agent ? "memberCard.agent" : "memberCard.person")}
          </p>
          {member.title && <p className="mt-0.5 truncate text-xs text-ink-2">{member.title}</p>}
        </div>
      </div>
      {(member.removed_at || member.suspended_at) && (
        <p className="px-3 pb-2">
          <Badge tone="wait">{t(member.removed_at ? "memberCard.removed" : "memberCard.suspended")}</Badge>
        </p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-line px-3 py-2.5 text-sm">
        <dt className="text-ink-3">{t("memberCard.role")}</dt>
        <dd>{t(`role.${member.role}`)}</dd>
        {agent && <AgentFacts member={member} />}
      </dl>
      {!member.removed_at && <TasksLink member={member} />}
    </PopoverContent>
  );
}

/** Who answers for an agent, and whether something is listening for its work now (data/listening.ts). */
function AgentFacts({ member }: { member: Member }) {
  const responsible = useMember(member.responsible_id);
  const listening = useListening()(member) === true;
  return (
    <>
      {responsible && (
        <>
          <dt className="text-ink-3">{t("memberCard.responsible")}</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <Avatar member={responsible} size="xs" />
            <span className="truncate">{responsible.name}</span>
          </dd>
        </>
      )}
      <dt className="text-ink-3">{t("memberCard.listening")}</dt>
      <dd className="flex items-center gap-1.5">
        <ListeningDot on={listening} />
        <span>{t(listening ? "memberCard.listeningNow" : "memberCard.notListening")}</span>
      </dd>
    </>
  );
}

/** The tasks page of the project in view, kept to the member's tasks. */
function TasksLink({ member }: { member: Member }) {
  const slug = useSlug();
  const project = projectInView(useLocation());
  if (!project) return null;
  // Only the member is looked up, to write them as "@handle".
  const tables = {
    projects: {},
    statuses: {},
    labels: {},
    epics: {},
    cycles: {},
    members: { [member.user_id]: member },
  };
  const search = searchFromFilters({ ...emptyFilters, assignee: [member.user_id] }, tables, project.id, "");
  return (
    <div className="border-t border-line p-1.5">
      <PopoverClose asChild>
        <Link
          to={`/${slug}/p/${project.key}/tasks${search}`}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-accent-text hover:bg-hover max-md:h-10"
        >
          <span className="flex-1">{t("memberCard.tasks")}</span>
          <span className="text-xs text-ink-3">{project.key}</span>
        </Link>
      </PopoverClose>
    </div>
  );
}
