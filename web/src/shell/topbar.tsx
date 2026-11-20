import { Menu as MenuIcon, Plus, Search } from "lucide-react";
import { MOD } from "@/hooks/hotkeys";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { ui, useUi } from "@/lib/ui-state";
import { ConnectionIndicator } from "@/shell/connection";
import { SidebarToggle } from "@/shell/sidebar";
import { RestLoadingHint } from "@/ui/rest-note";
import { UserMenu } from "@/shell/user-menu";
import { Button, IconButton } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Tooltip } from "@/ui/tooltip";

interface Props {
  /** Opens the create-task dialog for the project in view; none: no "New task" button (the member may not make one there). */
  onNewTask?: () => void;
}

export function TopBar({ onNewTask }: Props) {
  const title = useUi((s) => s.title);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  return (
    // In a window without a title bar (lib/window-inset.ts) the window is dragged by this bar too, and where the
    // sidebar does not reach the window's buttons (a drawer, or folded to its 3rem of icons) it leaves them their
    // space and takes the sidebar's toggle after it.
    <header
      data-window-bar
      className={cx(
        "flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-2 md:pl-4",
        "window-inset:h-[max(2.75rem,var(--window-inset-height))] max-md:window-inset:pl-(--window-inset-left)",
        collapsed && "md:window-inset:pl-[calc(var(--window-inset-left)-3rem)]",
      )}
    >
      <IconButton label={t("nav.open")} onClick={() => ui.setDrawer(true)} className="md:hidden">
        <MenuIcon className="size-4" />
      </IconButton>
      {collapsed && (
        <div className="hidden md:window-inset:flex">
          <SidebarToggle collapsed />
        </div>
      )}
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>

      <RestLoadingHint />
      <ConnectionIndicator />

      <button
        type="button"
        onClick={ui.openPalette}
        className="flex h-7 w-56 items-center gap-2 rounded-md border border-line bg-sunken px-2 text-sm text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2 max-lg:hidden"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">{t("top.search")}</span>
        <Kbd>{`${MOD} K`}</Kbd>
      </button>
      <IconButton label={t("top.searchShort")} hint={`${MOD} K`} onClick={ui.openPalette} className="lg:hidden">
        <Search className="size-4" />
      </IconButton>

      {onNewTask && (
        <Tooltip label={t("top.newTask")} hint="C">
          <Button
            variant="primary"
            onClick={onNewTask}
            aria-label={t("top.newTask")}
            className="max-sm:w-7 max-sm:px-0"
          >
            <Plus className="size-4" aria-hidden />
            <span className="max-sm:hidden">{t("top.newTask")}</span>
          </Button>
        </Tooltip>
      )}
      <UserMenu />
    </header>
  );
}
