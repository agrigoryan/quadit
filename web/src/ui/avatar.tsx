import { Bot } from "lucide-react";
import { cx } from "@/lib/cx";
import type { Member } from "@/lib/types";

type Size = "xs" | "sm" | "md" | "lg";

const boxes: Record<Size, string> = {
  xs: "size-4 text-[8px]",
  sm: "size-5 text-[9px]",
  md: "size-6 text-2xs",
  lg: "size-8 text-xs",
};
const badges: Record<Size, string> = { xs: "size-2", sm: "size-2.5", md: "size-3", lg: "size-3.5" };

// A calm tint per person, picked from their id so it never changes.
const tints = ["#5b6ee1", "#0f8a8a", "#b0578d", "#7a6ad8", "#2f8f5b", "#b7791f", "#4a7fb5", "#a85b4a"];

function tintOf(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return tints[h % tints.length] as string;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** An avatar is a picture's address, or a short text shown in its place: an emoji, or a letter or two. */
export const isPictureAvatar = (avatar: string | undefined): boolean =>
  !!avatar && /^(\/|https?:|data:|blob:)/.test(avatar);

interface Props {
  member: Pick<Member, "user_id" | "name" | "kind" | "avatar"> | undefined;
  size?: Size;
  className?: string;
}

/**
 * A person is a circle. An agent is a rounded square with a small "bot"
 * badge, so the two are told apart at a glance, even at 16 pixels.
 */
export function Avatar({ member, size = "sm", className }: Props) {
  if (!member) {
    return (
      <span
        className={cx(
          "inline-block shrink-0 rounded-full border border-dashed border-line-strong",
          boxes[size],
          className,
        )}
      />
    );
  }
  const agent = member.kind === "agent";
  const picture = isPictureAvatar(member.avatar);
  // An emoji is drawn larger than letters and on a quiet ground: it has colour of its own.
  const letters = !member.avatar || /^[\p{L}\p{N}]{1,2}$/u.test(member.avatar);
  return (
    <span className={cx("relative inline-flex shrink-0", className)} title={member.name}>
      {picture ? (
        <img
          src={member.avatar}
          alt=""
          className={cx("object-cover", boxes[size], agent ? "rounded-[28%]" : "rounded-full")}
        />
      ) : (
        <span
          aria-hidden
          className={cx(
            "inline-flex items-center justify-center overflow-hidden font-semibold text-white select-none",
            boxes[size],
            agent ? "rounded-[28%]" : "rounded-full",
            !letters && "bg-sunken text-[1.6em] leading-none",
          )}
          style={letters ? { background: tintOf(member.user_id) } : undefined}
        >
          {member.avatar ? (letters ? member.avatar.toUpperCase() : member.avatar) : initials(member.name)}
        </span>
      )}
      {agent && (
        <span
          className={cx(
            "absolute -right-1 -bottom-1 inline-flex items-center justify-center rounded-full bg-surface text-ink ring-1 ring-line-strong",
            badges[size],
          )}
        >
          <Bot className="size-[80%]" strokeWidth={2.2} aria-hidden />
        </span>
      )}
    </span>
  );
}
