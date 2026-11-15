// A person in a sentence about a decision, and filling a sentence's places
// with such elements.

import { Fragment, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { useMe, useMember } from "@/lib/selectors";
import { Avatar } from "@/ui/avatar";
import { nameOf } from "@/decisions/data";

/** Fills the {name} places of a translated sentence with elements. */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{name && name in parts ? parts[name] : piece}</Fragment>;
  });
}

/** Someone named in a sentence: avatar and name, or "you". */
export function Who({ userId, capital }: { userId: string | undefined; capital?: boolean }) {
  const member = useMember(userId);
  const me = useMe();
  const isMe = userId === me.user_id;
  return (
    <span className="inline-flex items-center gap-1 align-middle font-medium text-ink">
      <Avatar member={member} size="xs" className={member?.kind === "agent" ? "mr-0.5" : undefined} />
      {isMe ? (capital ? t("decision.youCapital") : t("common.you")) : nameOf(member, t("common.someone"))}
    </span>
  );
}
