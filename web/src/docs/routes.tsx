import { FilePlus2, FileText } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useLookupEvenIfGone, useProjectByKey, useSlug } from "@/data/selectors";
import { usePageTitle } from "@/lib/ui-state";
import { DocsAreaProvider, projectDocs, useDocsArea, workspaceDocs } from "@/docs/area";
import { inProject, treeIsEmpty, useDocTree } from "@/docs/data";
import { setNavigator } from "@/docs/nav";
import { DocPage } from "@/docs/page/doc-page";
import { ProjectDocsHome } from "@/docs/project-home";
import { MovePagesHere } from "@/docs/project-move";
import { DocsTree } from "@/docs/tree/docs-tree";
import { createAndOpen } from "@/docs/tree/new-page";
import { NotFoundPage } from "@/ui/not-found";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { ProjectGlyph } from "@/ui/project-glyph";

/** Everything under /:ws/docs, and under /:ws/p/KEY/docs for one project's pages. Loaded on demand. */
export default function DocsRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const { key } = useParams();
  const project = useProjectByKey(key);
  // Chips inside the editor navigate without router hooks (see docs/nav.ts).
  useEffect(() => {
    setNavigator(navigate, location);
    return () => setNavigator(null, null);
  }, [navigate, location]);

  if (key && !project) return <NotFoundPage />;
  return (
    <DocsAreaProvider project={project}>
      <Routes>
        <Route index element={<Area />} />
        <Route path=":id" element={<Area />} />
      </Routes>
    </DocsAreaProvider>
  );
}

/** The tree on the left, the page on the right. On a narrow screen one of the two shows at a time. */
function Area() {
  const { id } = useParams();
  const slug = useSlug();
  const { project } = useDocsArea();
  const tree = useDocTree(project?.id);
  // A page that is not one of this project's (its project was just changed, or the address is old)
  // goes on where it is now: in its own project's Docs, or in the workspace's.
  // A trashed page opens too (to be restored), and its own project may be archived.
  const docs = useLookupEvenIfGone("docs");
  const projects = useLookupEvenIfGone("projects");
  const elsewhere = useMemo(() => {
    const doc = id ? docs[id] : undefined;
    if (!project || !doc || inProject(docs, doc.id, project.id)) return undefined;
    const own = doc.project_id ? projects[doc.project_id] : undefined;
    return own ? projectDocs(slug, own) : workspaceDocs(slug);
  }, [docs, projects, id, project, slug]);
  const can = useCan();

  if (elsewhere) return <Navigate to={`${elsewhere}/${id}`} replace />;
  if (project && !id && treeIsEmpty(tree)) return <ProjectDocsHome project={project} empty />;
  return (
    <div className="flex h-full">
      <aside
        className={cx(
          "w-64 shrink-0 flex-col border-r border-line bg-canvas",
          id ? "hidden lg:flex" : "flex max-lg:w-full",
        )}
      >
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
          <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            {project && <ProjectGlyph project={project} />}
            <span className="truncate">{t("docs.title")}</span>
          </h1>
          {can.edit(project?.id) && (
            <div className="flex shrink-0 items-center gap-1">
              {/* On a narrow screen the tree is all there is: the project's home, which offers this beside it, does not show. */}
              {project && !id && (
                <span className="lg:hidden">
                  <MovePagesHere project={project} compact />
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => createAndOpen({ projectId: project?.id })}
                className="gap-1"
              >
                <FilePlus2 className="size-3.5" />
                {t("docs.new.page")}
              </Button>
            </div>
          )}
        </div>
        <DocsTree tree={tree} className="flex-1" />
      </aside>
      <section className={cx("min-w-0 flex-1", !id && "max-lg:hidden")}>
        {id ? <DocPage key={id} id={id} /> : project ? <ProjectDocsHome project={project} /> : <DocsHome />}
      </section>
    </div>
  );
}

function DocsHome() {
  usePageTitle(t("docs.title"));
  const can = useCan();
  return (
    <EmptyState
      icon={<FileText />}
      title={t("docs.home.title")}
      hint={t("docs.home.hint")}
      action={
        can.edit() && (
          <Button variant="primary" onClick={() => createAndOpen({})}>
            {t("docs.new.page")}
          </Button>
        )
      }
    />
  );
}
