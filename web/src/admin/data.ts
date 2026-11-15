// The keys the admin area's reads are cached under. They belong to no
// workspace: they go out whether or not a workspace's stream is live, and
// all of them go at sign-out.

export const adminKeys = {
  settings: ["admin", "settings"],
  users: ["admin", "users"],
  workspaces: ["admin", "workspaces"],
  backups: ["admin", "backups"],
  health: ["admin", "health"],
  /** The version of what agents can call, which has a version of its own. */
  changeSurface: ["admin", "change-surface"],
} as const;
