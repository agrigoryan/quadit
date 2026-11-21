import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { errorMessage } from "@/data/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { useCan } from "@/data/access";
import { useProjects, useSlug } from "@/data/selectors";
import { addSamples, samplesPath } from "@/tasks/samples";
import { Button } from "@/ui/button";

/**
 * Shown at the top of My work while the workspace has no project: tasks
 * live in projects, so making one is the first thing to do, or trying it
 * with the sample tasks first. Shows nothing once there is one.
 */
export function FirstProjectNudge() {
  const projects = useProjects();
  const can = useCan();
  const slug = useSlug();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (projects.length > 0) return null;
  const canCreate = can.administer;

  async function trySamples() {
    setBusy(true);
    try {
      void navigate(samplesPath(slug, await addSamples()));
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    // The highlighter means "your move": only for someone who can make the project.
    <section
      aria-labelledby="first-project"
      className={cx("border-b border-line px-4 py-4", canCreate ? "bg-move-soft/50" : "bg-sunken")}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span
          className={cx(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            canCreate ? "bg-move text-move-ink" : "bg-press text-ink-2",
          )}
        >
          <FolderPlus className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <h2 id="first-project" className="text-base font-semibold">
            {t("auth.firstRun.title")}
          </h2>
          <p className="text-sm text-ink-2">{canCreate ? t("auth.firstRun.lead") : t("auth.firstRun.memberLead")}</p>
        </div>
        {canCreate && (
          <div className="flex shrink-0 items-center gap-1">
            {/* Asks nothing first: the sample tasks are removed in one click from their project. */}
            <Button variant="ghost" className="h-8 px-3" disabled={busy} onClick={() => void trySamples()}>
              {t("auth.firstRun.samples")}
            </Button>
            <Link
              to={`/${slug}/settings/projects?new=1`}
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-md bg-accent px-3 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {t("auth.firstRun.create")}
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
