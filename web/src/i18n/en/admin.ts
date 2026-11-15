// Strings for the admin part of the app: its pages, and the audit log.

import { auditStrings } from "@/i18n/en/admin-audit";
import { adminStrings } from "@/i18n/en/admin-pages";

export const admin = { ...adminStrings, ...auditStrings };
