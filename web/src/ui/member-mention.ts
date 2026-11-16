// What a member's mention opens, wherever text is drawn from Markdown
// (ui/markdown.tsx). The ui layer cannot know the card about a member, which
// leads to a feature's page: the shell gives it (tasks/member-card.tsx).

import { createContext, type ReactElement, type ReactNode } from "react";
import type { Member } from "@/types/core";

/**
 * Given the member and the mention, a control, it draws the control with
 * what it opens around it. Left out, a mention is a plain name.
 */
export const MemberMention = createContext<((member: Member, control: ReactElement) => ReactNode) | null>(null);
