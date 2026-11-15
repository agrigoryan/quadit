import { Menu as MenuIcon, Plus, Search } from "lucide-react";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import { ui, useUi } from "@/lib/ui-state";
import { ConnectionIndicator } from "@/shell/connection";
import { RestLoadingHint } from "@/ui/rest-note";
import { UserMenu } from "@/shell/user-menu";
import { Button, IconButton } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { Tooltip } from "@/ui/tooltip";

interface Props {
  /** Opens the create-task dialog for the project in view. */
  onNewTask: () => void;
}

export function TopBar({ onNewTask }: Props) {
  const title = useUi((s) => s.title);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-2 md:pl-4">
      <IconButton label={t("nav.open")} onClick={() => ui.setDrawer(true)} className="md:hidden">
        <MenuIcon className="size-4" />
      </IconButton>
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

      <Tooltip label={t("top.newTask")} hint="C">
        <Button variant="primary" onClick={onNewTask} aria-label={t("top.newTask")} className="max-sm:w-7 max-sm:px-0">
          <Plus className="size-4" aria-hidden />
          <span className="max-sm:hidden">{t("top.newTask")}</span>
        </Button>
      </Tooltip>
      <UserMenu />
    </header>
  );
}
