import type { Project } from "@/lib/types";

/** A project's key in a small square: its mark wherever the project is named. */
export function ProjectGlyph({ project }: { project: Pick<Project, "key" | "color"> }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-xs text-[8px] leading-none font-bold text-white"
      style={{ background: project.color || "var(--ink-2)" }}
      aria-hidden
    >
      {project.key.slice(0, 2)}
    </span>
  );
}
