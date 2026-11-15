// An audit log: who did what, when and from where. The admin area shows the
// whole install's; workspace settings show one workspace's. Both read the
// same shape with the same filters, newest first, a page at a time.

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronRight, Download } from "lucide-react";
import { api } from "@/lib/api";
import { readError } from "@/lib/query";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { exact, toTheSecond } from "@/lib/time";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading, Spinner } from "@/ui/spinner";
import { AuditFilterBar, type AuditFilters, anyFilter, auditQuery, type Named, noFilters } from "@/admin/audit-filters";
import { download } from "@/lib/download";
import { EmptyRow, Page } from "@/ui/page-layout";

export interface AuditEntry {
  id: string;
  at: number;
  workspace_id?: string;
  actor_id?: string;
  actor_name?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  ip?: string;
  user_agent?: string;
  data?: unknown;
}

const PAGE = 100;

interface Props {
  /** The page around the log: its title, what it holds, and where "back" goes on a phone. */
  title: string;
  lead: string;
  back: string;
  /** Where the log is read: "/api/v1/admin/audit", or a workspace's "/audit". */
  endpoint: string;
  /** People and agents to offer in the "who" filter, and to name targets with. */
  actors?: Named[];
  /** Given for the install's log: adds the workspace filter and column. */
  workspaces?: Named[];
}

function Target({ entry, names }: { entry: AuditEntry; names: Map<string, string> }) {
  if (!entry.target_type && !entry.target_id) return <span className="text-ink-3">–</span>;
  const known = entry.target_id ? names.get(entry.target_id) : undefined;
  const isId = /^[0-9a-f]{8}-/.test(entry.target_id ?? "");
  return (
    <span className="truncate">
      <span className="text-ink-3">{entry.target_type}</span>{" "}
      {known ??
        (isId ? (
          <span className="font-mono text-xs text-ink-3">{entry.target_id?.slice(-6)}</span>
        ) : (
          <span className="font-mono text-xs">{entry.target_id}</span>
        ))}
    </span>
  );
}

function Details({ entry, names }: { entry: AuditEntry; names: Map<string, string> }) {
  const facts: [string, React.ReactNode][] = [
    [t("audit.col.time"), exact(entry.at)],
    [t("audit.col.target"), [entry.target_type, entry.target_id].filter(Boolean).join(" ") || "–"],
  ];
  if (entry.workspace_id) facts.push([t("audit.col.workspace"), names.get(entry.workspace_id) ?? entry.workspace_id]);
  if (entry.ip) facts.push([t("audit.col.ip"), entry.ip]);
  if (entry.user_agent) facts.push([t("audit.detail.browser"), entry.user_agent]);
  return (
    <div className="border-t border-line bg-sunken/60 px-3 py-2.5 md:pl-10">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-3">{label}</dt>
            <dd className="min-w-0 break-words text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
      {entry.data !== undefined && entry.data !== null && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-xs text-ink-2">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  names,
  showWorkspace,
}: {
  entry: AuditEntry;
  names: Map<string, string>;
  showWorkspace: boolean;
}) {
  const [open, setOpen] = useState(false);
  const actor = entry.actor_name || (entry.actor_id && names.get(entry.actor_id)) || t("audit.system");
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-x-3 px-3 py-1.5 text-left text-sm hover:bg-hover/60 max-md:flex-wrap md:min-h-9"
      >
        <ChevronRight
          className={cx("size-3.5 shrink-0 text-ink-3 transition-transform max-md:hidden", open && "rotate-90")}
          aria-hidden
        />
        <time
          dateTime={new Date(entry.at).toISOString()}
          title={exact(entry.at)}
          className="shrink-0 text-xs text-ink-3 tnum max-md:order-3 max-md:w-full md:w-36"
        >
          {toTheSecond(entry.at)}
        </time>
        <span className="min-w-0 truncate font-medium text-ink max-md:order-1 max-md:flex-1 md:w-36 md:shrink-0">
          {actor}
        </span>
        <span className="shrink-0 rounded-sm border border-line bg-sunken px-1.5 font-mono text-xs leading-5 text-ink-2 max-md:order-2 md:w-52 md:truncate md:border-0 md:bg-transparent md:px-0 md:text-ink">
          {entry.action}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-2 max-md:hidden">
          <Target entry={entry} names={names} />
        </span>
        {showWorkspace && (
          <span className="w-28 shrink-0 truncate text-ink-2 max-lg:hidden">
            {entry.workspace_id ? (names.get(entry.workspace_id) ?? "") : ""}
          </span>
        )}
        <span className="w-24 shrink-0 truncate text-right font-mono text-xs text-ink-3 max-lg:hidden">{entry.ip}</span>
      </button>
      {open && <Details entry={entry} names={names} />}
    </li>
  );
}

/** A whole page: the filters, the export button in the page's corner, and the log. */
export function AuditLog({ title, lead, back, endpoint, actors, workspaces }: Props) {
  const [filters, setFilters] = useState<AuditFilters>(noFilters);
  // The filters the log is read with: those typed, a moment after the typing stops.
  const [applied, setApplied] = useState(filters);
  useEffect(() => {
    if (applied === filters) return;
    const timer = setTimeout(() => setApplied(filters), 250);
    return () => clearTimeout(timer);
  }, [filters, applied]);

  const query = auditQuery(applied);
  const log = useInfiniteQuery({
    // The admin area's log and a workspace's differ by endpoint; the filters are compared by their text.
    queryKey: ["audit", endpoint, query],
    queryFn: ({ pageParam, signal }) =>
      api.get<{ audit?: AuditEntry[]; next?: string }>(
        `${endpoint}?${auditQuery(applied, pageParam ? { limit: PAGE, cursor: pageParam } : { limit: PAGE })}`,
        signal,
      ),
    initialPageParam: "",
    // The server's `next`, sent back as `cursor`; none when everything is shown.
    getNextPageParam: (last) => last.next || undefined,
    // Other filters keep the rows on screen, dimmed, until their own answer comes.
    placeholderData: keepPreviousData,
  });
  const rows = log.data ? log.data.pages.flatMap((page) => page.audit ?? []) : null;
  const busy = log.isFetching;
  const error = readError(log.error);

  const names = new Map<string, string>();
  for (const n of [...(actors ?? []), ...(workspaces ?? [])]) names.set(n.id, n.name);

  return (
    <Page
      title={title}
      lead={lead}
      back={back}
      wide
      actions={
        <Button onClick={() => download(`${endpoint}?${auditQuery(filters, { format: "csv" })}`)}>
          <Download className="size-3.5" aria-hidden />
          {t("audit.csv")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <AuditFilterBar value={filters} onChange={setFilters} actors={actors} workspaces={workspaces} />

        {rows === null ? (
          error ? (
            <EmptyState
              title={t("s.loadFailed")}
              hint={error}
              action={<Button onClick={() => void log.refetch()}>{t("common.tryAgain")}</Button>}
            />
          ) : (
            <Loading />
          )
        ) : rows.length === 0 ? (
          <EmptyRow>{anyFilter(filters) ? t("audit.noneMatching") : t("audit.none")}</EmptyRow>
        ) : (
          <div className={cx("overflow-hidden rounded-lg border border-line", busy && "opacity-70")}>
            <div className="flex items-center gap-x-3 border-b border-line bg-sunken px-3 py-1.5 text-xs font-medium text-ink-3 max-md:hidden">
              <span className="w-3.5" />
              <span className="w-36">{t("audit.col.time")}</span>
              <span className="w-36">{t("audit.col.actor")}</span>
              <span className="w-52">{t("audit.col.action")}</span>
              <span className="flex-1">{t("audit.col.target")}</span>
              {workspaces && <span className="w-28 max-lg:hidden">{t("audit.col.workspace")}</span>}
              <span className="w-24 text-right max-lg:hidden">{t("audit.col.ip")}</span>
            </div>
            <ul className="divide-y divide-line">
              {rows.map((entry) => (
                <EntryRow key={entry.id} entry={entry} names={names} showWorkspace={!!workspaces} />
              ))}
            </ul>
          </div>
        )}

        {rows !== null && error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs text-ink-3">
            <span>{t("audit.shown", { n: rows.length })}</span>
            {log.hasNextPage ? (
              <Button onClick={() => void log.fetchNextPage()} disabled={busy}>
                {busy && <Spinner className="size-3" />}
                {t("audit.more")}
              </Button>
            ) : (
              <span>{t("audit.end")}</span>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
