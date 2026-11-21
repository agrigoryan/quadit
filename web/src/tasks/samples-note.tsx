import { useState } from "react";
import { useNavigate } from "react-router";
import { useCan } from "@/data/access";
import { mutate } from "@/data/mutate";
import { getRow, useLookup, useSlug } from "@/data/selectors";
import { t } from "@/lib/i18n";
import { samplesLeft } from "@/tasks/samples";
import type { Project } from "@/types/core";
import { Button } from "@/ui/button";

/**
 * Shown above the task list of the project the sample tasks are in, while
 * any of them is out of the trash: what they are for, which one waits on
 * an agent, and a button that removes them (the trash is the undo).
 */
export function SamplesNote({ project }: { project: Project }) {
  const tasks = useLookup("tasks");
  const members = useLookup("members");
  const can = useCan();
  const slug = useSlug();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const left = samplesLeft(project, tasks, members);
  if (!left) return null;

  function remove() {
    setBusy(true);
    // Both ways it ends are handled here.
    void mutate({ type: "samples.remove", args: {} }).then(
      // Their project went with them when nothing of the person's own was in it: nothing is left to show here.
      () => {
        if (!getRow("projects", project.id)) void navigate(`/${slug}`);
      },
      // mutate has shown the refusal; the button can be pressed again.
      () => setBusy(false),
    );
  }

  return (
    <section
      aria-label={t("samples.note.label")}
      className="mx-2 mt-3 mb-1 flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 md:mx-3"
    >
      <img src="/quadit.svg" alt="" className="size-9 shrink-0 rounded-lg" />
      <p className="min-w-0 flex-1 basis-64 text-sm text-ink-2">
        <strong className="font-semibold text-ink">{t("samples.note.lead")}</strong>
        {left.forAgent && <> {t("samples.note.agent", left.forAgent)}</>}
      </p>
      {can.administer && (
        <Button onClick={remove} disabled={busy}>
          {t("samples.note.remove")}
        </Button>
      )}
    </section>
  );
}
