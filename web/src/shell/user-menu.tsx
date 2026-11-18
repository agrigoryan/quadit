import { AppWindow, Keyboard, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { saveTheme, signOut, useSession } from "@/auth/session";
import { t } from "@/lib/i18n";
import { useMe, useSlug } from "@/data/selectors";
import { type ThemeChoice, useThemeChoice } from "@/lib/theme";
import { ui } from "@/lib/ui-state";
import { Avatar } from "@/ui/avatar";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/ui/menu";

const themes: ThemeChoice[] = ["system", "light", "dark"];

/** The link that opens this page in the Quadit desktop app's window of this server. */
const appLink = (path: string) =>
  `quadit://open?server=${encodeURIComponent(window.location.origin)}&path=${encodeURIComponent(path)}`;

export function UserMenu() {
  const me = useMe();
  const slug = useSlug();
  const user = useSession((s) => s.user);
  const navigate = useNavigate();
  const theme = useThemeChoice();
  const location = useLocation();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t("top.account")}
          className="flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-hover data-[state=open]:bg-hover"
        >
          <Avatar member={me} size="md" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-56">
        <div className="px-2 pt-1.5 pb-2">
          <p className="truncate text-sm font-medium">{me.name}</p>
          <p className="truncate text-xs text-ink-3">{user?.email ?? `@${me.handle}`}</p>
        </div>
        <MenuSeparator />
        <MenuItem icon={<UserRound />} onSelect={() => navigate(`/${slug}/settings/me/profile`)}>
          {t("top.profile")}
        </MenuItem>
        <MenuItem icon={<Keyboard />} hint="?" onSelect={() => ui.setShortcuts(true)}>
          {t("top.shortcuts")}
        </MenuItem>
        {/* In a browser only: a window of the app is there already. The app refuses a server it was not given. */}
        {!window.quaditDesktop && (
          <MenuItem icon={<AppWindow />} onSelect={() => window.location.assign(appLink(location.pathname))}>
            {t("top.openInApp")}
          </MenuItem>
        )}
        {user?.is_admin && (
          <MenuItem icon={<ShieldCheck />} onSelect={() => navigate("/admin")}>
            {t("auth.admin")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuLabel>{t("top.theme")}</MenuLabel>
        <MenuRadioGroup value={theme} onValueChange={(v) => void saveTheme(v as ThemeChoice)}>
          {themes.map((choice) => (
            <MenuRadioItem key={choice} value={choice} onSelect={(e) => e.preventDefault()}>
              {t(`top.theme.${choice}`)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
          {t("top.signOut")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
