// The addresses of pages. A page has one in the workspace's Docs and, when
// it is one of a project's pages, one in that project's Docs too; both show
// it, inside the area they belong to (docs/area.tsx).

import type { Project } from "@/types/core";

export const workspaceDocs = (slug: string) => `/${slug}/docs`;
export const projectDocs = (slug: string, project: Pick<Project, "key">) => `/${slug}/p/${project.key}/docs`;

/**
 * A page's address: in the workspace's Docs, which every page has (the one to
 * hand on), or in the Docs of `project`, one of whose pages it is.
 */
export const docPath = (slug: string, id: string, project?: Pick<Project, "key">) =>
  `${project ? projectDocs(slug, project) : workspaceDocs(slug)}/${id}`;
