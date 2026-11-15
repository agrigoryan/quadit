// Every place in a workspace that has a name. One table: the "G then a
// letter" key sequences, the palette's "Go to" rows and the shortcuts sheet
// all read it, so a place added here shows up in all three.

import type { ReactNode } from "react";
import { Bot, ChartGantt, FileText, Inbox, Kanban, Layers, LayoutDashboard, ListTodo, MessageCircleQuestion, RefreshCw, Settings, Trash2, UserRound, Wrench } from "lucide-react";
import type { Key } from "@/lib/i18n";
import type { Project } from "@/lib/types";

export interface Destination {
  id: string;
  /** The letter that follows G. A place too rarely visited to earn one has none. */
  key?: string;
  label: Key;
  icon: ReactNode;
  /** Under /:ws/; for a page each project has, under /:ws/p/KEY/. An address from the root starts with "/". */
  path: string;
  /** A page each project has. The palette lists it once per project, under this name. */
  perProject?: Key;
  /** More words the palette's search should match. */
  words?: string;
  /** Left out where it does not apply: a project without cycles, a person who does not run the install. */
  needs?: "cycles" | "installAdmin";
}

// The letter is the place's initial where that is free (Inbox, My work as
// in Linear and Gmail), else the first letter of its name that is; Decisions
// are the questions (Q), and the trash is X as Linear's archive is.
export const DESTINATIONS: Destination[] = [
  { id: "my-work", key: "m", label: "nav.myWork", icon: <UserRound />, path: "my-work", words: "home assigned" },
  { id: "inbox", key: "i", label: "nav.inbox", icon: <Inbox />, path: "inbox", words: "notifications" },
  { id: "tasks", key: "t", label: "nav.tasks", icon: <ListTodo />, path: "tasks", perProject: "palette.projectTasks", words: "list" },
  { id: "board", key: "b", label: "nav.board", icon: <Kanban />, path: "board", perProject: "palette.projectBoard", words: "kanban" },
  { id: "timeline", key: "l", label: "nav.timeline", icon: <ChartGantt />, path: "timeline", perProject: "palette.projectTimeline", words: "gantt roadmap" },
  { id: "epics", key: "e", label: "nav.epics", icon: <Layers />, path: "epics", perProject: "palette.projectEpics" },
  { id: "cycles", key: "c", label: "nav.cycles", icon: <RefreshCw />, path: "cycles", perProject: "palette.projectCycles", words: "sprints", needs: "cycles" },
  { id: "docs", key: "d", label: "nav.docs", icon: <FileText />, path: "docs", words: "pages documents wiki" },
  { id: "dashboard", key: "h", label: "nav.dashboard", icon: <LayoutDashboard />, path: "dashboard", words: "overview charts home" },
  { id: "agents", key: "a", label: "nav.agents", icon: <Bot />, path: "agents", words: "sessions" },
  { id: "decisions", key: "q", label: "nav.decisions", icon: <MessageCircleQuestion />, path: "decisions", words: "questions log" },
  { id: "trash", key: "x", label: "nav.trash", icon: <Trash2 />, path: "trash", words: "deleted" },
  { id: "settings", key: "s", label: "nav.settings", icon: <Settings />, path: "settings", words: "preferences" },
  { id: "admin", label: "palette.admin", icon: <Wrench />, path: "/admin", words: "install server instance", needs: "installAdmin" },
];

/** What decides whether a place is there to go to, and where exactly it is. */
export interface Where {
  slug: string;
  /** The project whose pages the per-project places stand for. */
  project: Project | undefined;
  installAdmin: boolean;
}

/** The address of a place, or undefined where it does not apply (no project, cycles off, not the install's admin). */
export function destinationPath(place: Destination, { slug, project, installAdmin }: Where): string | undefined {
  if (place.needs === "installAdmin" && !installAdmin) return undefined;
  if (place.path.startsWith("/")) return place.path;
  if (!place.perProject) return `/${slug}/${place.path}`;
  if (!project || (place.needs === "cycles" && !project.settings?.cycles)) return undefined;
  return `/${slug}/p/${project.key}/${place.path}`;
}

/** How a place's sequence is written in a hint: "G I". */
export const goKeys = (place: Destination) => (place.key ? `G ${place.key.toUpperCase()}` : undefined);
