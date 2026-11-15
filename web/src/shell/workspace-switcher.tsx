import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { useCanCreateWorkspace } from "@/auth/config";
import { CreateWorkspaceDialog } from "@/auth/create-workspace";
import { useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { useStore } from "@/data/store";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu";

/** The workspace's name; opens the list of the person's other workspaces. */
export function WorkspaceSwitcher() {
  const workspace = useStore((s) => s.workspace);
  const workspaces = useSession((s) => s.workspaces);
  const navigate = useNavigate();
  const canCreate = useCanCreateWorkspace();
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
          <WorkspaceMark name={workspace.name} icon={workspace.icon} />
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
            <span className="flex min-w-0 items-center gap-2">
              {/* The open workspace's icon follows the live copy; the others are as of sign-in. */}
              <WorkspaceMark name={w.name} icon={w.slug === workspace.slug ? workspace.icon : w.icon} />
              <span className="truncate">{w.name}</span>
            </span>
          </MenuItem>
        ))}
        {canCreate && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Plus />} onSelect={() => setCreating(true)}>
              {t("auth.workspace.create")}
            </MenuItem>
          </>
        )}
      </MenuContent>
      {canCreate && creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
    </Menu>
  );
}

/** A workspace's icon (an emoji) when it has one; otherwise the first letter of its name on a dark tile. */
function WorkspaceMark({ name, icon }: { name: string; icon?: string }) {
  if (icon) {
    return (
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-base leading-none">
        {icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-ink text-2xs font-bold text-surface"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
