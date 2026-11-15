// Where the Docs area is showing: the whole workspace's pages, or one
// project's (/:ws/p/KEY/docs). The tree, the page header and "new page"
// read it to know which pages to list, where their links lead and which
// project a new page is tied to.

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useSlug } from "@/lib/selectors";
import type { Project } from "@/lib/types";

export interface DocsArea {
  /** The address the pages hang under: `${base}/${id}`. */
  base: string;
  /** The project whose pages are showing; none in the workspace's Docs. */
  project?: Project;
}

const Context = createContext<DocsArea | null>(null);

export const workspaceDocs = (slug: string) => `/${slug}/docs`;
export const projectDocs = (slug: string, project: Pick<Project, "key">) => `/${slug}/p/${project.key}/docs`;

export function DocsAreaProvider({ project, children }: { project?: Project; children: ReactNode }) {
  const slug = useSlug();
  const area = useMemo(() => ({ base: project ? projectDocs(slug, project) : workspaceDocs(slug), project }), [slug, project]);
  return <Context value={area}>{children}</Context>;
}

/** The area around the caller. Outside the Docs area (the sidebar, a row's side peek) it is the workspace's. */
export function useDocsArea(): DocsArea {
  const slug = useSlug();
  const area = useContext(Context);
  return useMemo(() => area ?? { base: workspaceDocs(slug) }, [area, slug]);
}
