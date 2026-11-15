// The workspace settings' reads that are not in the store: the
// invitations, their shapes, and the key they are cached under.

import { inWorkspace } from "@/lib/query";
import type { Role } from "@/lib/types";

export interface Invite {
  id: string;
  email?: string;
  role: Role;
  created_by: string;
  created_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
}

/** The key the workspace's invitations are cached under. */
export const invitesKey = (slug: string) => [...inWorkspace(slug), "invites"] as const;

export interface Created {
  invite: Invite;
  link: string;
  mailed: boolean;
}
