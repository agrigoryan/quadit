import { useRef, useState } from "react";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { Dialog as RDialog, VisuallyHidden } from "radix-ui";
import { matchPath, useLocation, useNavigate } from "react-router";
import { t } from "@/lib/i18n";
import { useSlug, useTaskByKey } from "@/lib/selectors";
import { ui, useUi } from "@/lib/ui-state";
import { choiceTitle, ChoicesPage } from "@/palette/palette-choices";
import type { ChoicePage, MakePage, PalettePage } from "@/palette/palette-commands";
import { makeTitle, MakePageRows } from "@/palette/palette-make";
import { RootPage } from "@/palette/palette-root";
import { useServerSearch } from "@/palette/palette-search";
import { focusPage } from "@/shell/page-focus";
import { pageUnder, projectInView } from "@/shell/project-in-view";
import { useTaskNav } from "@/tasks/task-link";
import { Spinner } from "@/ui/spinner";

/**
 * The command palette (Cmd/Ctrl-K): one box to jump anywhere, find a task,
 * search every text, and act on the task that is open.
 */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  // Mounted only while open, so each opening starts on the first page with an empty box.
  return open ? <Palette /> : null;
}

function Palette() {
  const slug = useSlug();
  const location = useLocation();
  const navigate = useNavigate();
  const tasks = useTaskNav();
  const [page, setPage] = useState<"root" | PalettePage>("root");
  const [query, setQuery] = useState("");
  const box = useRef<HTMLInputElement>(null);

  const taskKey = matchPath("/:ws/task/:key", location.pathname)?.params.key;
  const task = useTaskByKey(taskKey);
  const openTask = task && !task.deleted_at ? task : undefined;
  // Where a new task, label or status goes, and whose pages the letters after G open.
  const project = projectInView(location);

  // A page that needs the open task or a project falls back to the first page without one.
  const making: MakePage | null = (page === "new-label" || page === "new-status") && project ? page : null;
  const choosing: ChoicePage | null = page !== "root" && page !== "new-label" && page !== "new-status" && openTask ? page : null;
  const onRoot = !making && !choosing;
  const search = useServerSearch(onRoot ? query : "");

  const close = () => ui.setPalette(false);
  /** True once a command has run: the keyboard then goes to the page, not back to what opened the palette. */
  const ran = useRef(false);
  const run = (action: () => void) => {
    ran.current = true;
    close();
    action();
  };
  const toPage = (next: "root" | PalettePage) => {
    setPage(next);
    setQuery("");
    // A row chosen with the mouse leaves the focus on the list; what is typed next belongs in the box.
    box.current?.focus();
  };

  return (
    <RDialog.Root open onOpenChange={(next) => !next && close()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[70] bg-overlay animate-fade" />
        <RDialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (!ran.current) return;
            e.preventDefault();
            focusPage();
          }}
          onEscapeKeyDown={(e) => {
            if (onRoot) return;
            e.preventDefault();
            toPage("root");
          }}
          className="fixed inset-x-0 top-0 z-[70] overflow-hidden bg-surface text-ink shadow-pop outline-none animate-pop max-sm:rounded-b-xl sm:top-[12vh] sm:left-1/2 sm:w-[min(600px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:rounded-xl"
        >
          <VisuallyHidden.Root>
            <RDialog.Title>{t("palette.title")}</RDialog.Title>
          </VisuallyHidden.Root>
          <Command
            label={t("palette.title")}
            shouldFilter={false}
            vimBindings={false}
            loop
            onKeyDown={(e) => {
              if (!onRoot && e.key === "Backspace" && query === "") {
                e.preventDefault();
                toPage("root");
              }
            }}
          >
            <div className="flex h-12 items-center gap-2.5 border-b border-line pr-3 pl-4">
              {onRoot ? (
                <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
              ) : (
                <span className="flex h-5 shrink-0 items-center rounded-sm bg-sunken px-1.5 text-xs font-medium text-ink-2 tnum">
                  {choosing ? openTask?.key : project?.key}
                </span>
              )}
              <Command.Input
                ref={box}
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={making ? makeTitle[making]() : choosing ? choiceTitle[choosing]() : t("palette.placeholder")}
                className="h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3 max-sm:text-[16px]"
              />
              <span className="flex size-4 shrink-0 items-center justify-center">
                {search.busy && <Spinner className="size-3.5" label={t("palette.searching")} />}
              </span>
            </div>
            <Command.List className="max-h-[min(26rem,60dvh)] scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5">
              {making && project ? (
                <MakePageRows page={making} project={project} query={query} run={run} />
              ) : choosing && openTask ? (
                <ChoicesPage page={choosing} task={openTask} query={query} run={run} />
              ) : (
                <RootPage
                  query={query}
                  slug={slug}
                  task={openTask}
                  expand={openTask && pageUnder(location) ? () => tasks.page(openTask.key) : undefined}
                  project={project}
                  hits={search.hits}
                  searching={search.busy}
                  run={run}
                  go={(path) => run(() => navigate(path))}
                  openTask={(key) => run(() => tasks.peek(key))}
                  openPage={toPage}
                />
              )}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
