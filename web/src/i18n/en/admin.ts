// Strings for the admin part of the app, kept beside its pages (admin/strings*.ts).

import { adminStrings } from "@/admin/strings";
import { auditStrings } from "@/admin/strings-audit";
import { adminMoreStrings } from "@/admin/strings-more";

export const admin = { ...adminStrings, ...adminMoreStrings, ...auditStrings };
