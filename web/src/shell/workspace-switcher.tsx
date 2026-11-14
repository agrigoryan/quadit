import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { CreateWorkspaceDialog } from "@/auth/create-workspace";
import { useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu";

/** The workspace's name; opens the list of the person's other workspaces. */
export function WorkspaceSwitcher() {
  const workspace = useStore((s) => s.workspace);
  const workspaces = useSession((s) => s.workspaces);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  if (!workspace) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t("nav.switchWorkspace")}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left hover:bg-press/60 data-[state=open]:bg-press"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-ink text-2xs font-bold text-surface">
            {workspace.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{workspace.name}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent className="w-56">
        <MenuLabel>{t("nav.switchWorkspace")}</MenuLabel>
        {workspaces.map((w) => (
          <MenuItem
            key={w.id}
            onSelect={() => navigate(`/${w.slug}`)}
            icon={w.slug === workspace.slug ? <Check /> : <span className="size-4" />}
          >
            {w.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Plus />} onSelect={() => setCreating(true)}>
          {t("auth.workspace.create")}
        </MenuItem>
      </MenuContent>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </Menu>
  );
}
