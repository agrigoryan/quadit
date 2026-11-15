// What agents share as the server sends it (internal/core/agents.go):
// resources they take turns on and the claims queued on them.

/** A shared machine or device only one member may use at a time (core.Resource). */
export type Resource = {
  id: string;
  name: string;
  description?: string;
  created_at: number;
  updated_seq: number;
  deleted_at?: number;
};

/** One place in a resource's queue, or the hold on it (core.ResourceClaim). A released claim stays in the store; skip it. */
export type Claim = {
  id: string;
  resource_id: string;
  user_id: string;
  task_id?: string;
  note?: string;
  state: "holding" | "waiting" | "released";
  requested_at: number;
  acquired_at?: number;
  /** While holding: when the hold ends. While waiting: the minutes asked for. */
  lease_until?: number;
  released_at?: number;
};
