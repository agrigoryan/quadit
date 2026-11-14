import { t } from "@/lib/i18n";
import type { Role } from "@/lib/types";

export const ROLES: Role[] = ["owner", "admin", "member"];

/** Roles as choices for a select, strongest first. */
export const roleChoices = (roles: Role[] = ROLES) => roles.map((r) => ({ value: r, label: t(`role.${r}`) }));
