// The commits on a linked branch, under the link: how far it is ahead of
// its base, and what each commit says. A long list starts folded.

import { useId, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { t } from "@/lib/i18n";
import type { TaskLink } from "@/types/core";

interface Commit {
  sha: string;
  subject: string;
}

/** What a branch link carries besides its name: sent by whatever keeps it current (the git hook, an integration). */
interface BranchData {
  commits: Commit[];
  ahead?: number;
  base?: string;
}

const SHOWN = 5;

/** Reads the link's free-form `data`, keeping only what is well formed. */
function branchData(link: TaskLink): BranchData | null {
  const data = (link as TaskLink & { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const { commits, ahead, base } = data as Record<string, unknown>;
  const list = (Array.isArray(commits) ? commits : []).flatMap((c): Commit[] => {
    const { sha, subject } = (c ?? {}) as Record<string, unknown>;
    return typeof sha === "string" && sha ? [{ sha, subject: typeof subject === "string" ? subject : "" }] : [];
  });
  const out: BranchData = { commits: list };
  if (typeof ahead === "number") out.ahead = ahead;
  if (typeof base === "string" && base) out.base = base;
  return list.length > 0 || out.ahead !== undefined ? out : null;
}

/** Draws nothing for a link that is not a branch or says nothing about its commits. */
export function BranchCommits({ link }: { link: TaskLink }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const data = link.kind === "branch" ? branchData(link) : null;
  if (!data) return null;

  const { commits } = data;
  const count = data.ahead ?? commits.length;
  const folded = commits.length > SHOWN && !all;
  const shown = folded ? commits.slice(0, SHOWN) : commits;
  // Once merged nothing is ahead any more; the commits listed are the ones that went in.
  const summary =
    link.state === "merged"
      ? t("detail.commits.merged", { n: count })
      : data.base
        ? t("detail.commits.ahead", { n: count, base: data.base })
        : t("detail.commits.count", { n: count });

  return (
    <div className="basis-full pb-1 pl-6">
      <p className="text-xs text-ink-3">{summary}</p>
      {commits.length > 0 && (
        <ol id={listId} aria-label={t("detail.commits.on", { name: link.ref ?? "" })} className="mt-0.5">
          {shown.map((c) => (
            <li key={c.sha} className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-ink-2">
              <GitCommitHorizontal className="size-3 shrink-0 text-ink-3" aria-hidden />
              <code className="shrink-0 font-mono text-2xs text-ink-3">{c.sha.slice(0, 7)}</code>
              <span className="min-w-0 truncate" title={c.subject}>
                {c.subject}
              </span>
            </li>
          ))}
        </ol>
      )}
      {commits.length > SHOWN && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((v) => !v)}
          className="mt-0.5 -ml-1 rounded-sm px-1 text-xs font-medium text-ink-2 hover:bg-hover hover:text-ink max-md:py-1.5"
        >
          {all ? t("detail.commits.fewer") : t("detail.commits.all", { n: commits.length })}
        </button>
      )}
    </div>
  );
}
