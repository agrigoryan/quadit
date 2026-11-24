// Removing an agent from the workspace, asked first: its tokens stop
// working, its open tasks become unassigned, its history stays.

import { t } from "@/lib/i18n";
import { mutate } from "@/data/mutate";
import type { Member } from "@/types/core";
import { ConfirmDialog } from "@/ui/confirm-dialog";

/** Asks before removing the agent; `onRemoved` runs once the server has. */
export function RemoveAgentDialog({
  agent,
  open,
  onOpenChange,
  onRemoved,
}: {
  agent: Pick<Member, "user_id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved?: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("agent.remove.title", { name: agent.name })}
      body={t("agent.removeLead")}
      confirm={t("s.remove")}
      onConfirm={async () => {
        await mutate({ type: "member.remove", args: { id: agent.user_id } }, undefined, { quiet: true });
        onRemoved?.();
      }}
    />
  );
}
