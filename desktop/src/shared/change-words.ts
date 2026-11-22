// What connecting a tool changes, in the words of someone who is not
// technical (desktop contract §10): the line on a tool's card, and, in "See
// the files", each file by what it is for, a sentence, and what happens to
// it. The words come from what the tool is and the kind of change the plan
// makes to each file (PlanFile's role and change), never from reading a
// diff, which stays behind "Show the exact changes".

import type { FileChange, FileRole, PlanFile, Unrevoked } from "@/shared/pages-api";

/**
 * The line on a tool's card saying what connecting changes on disk (`done`:
 * what it changed), and whom the tool works as: the quadit command when the
 * computer has none on its PATH yet (`addsCommand`), the skill, and the
 * tool's own login where it can have one (`ownLogin`); else it signs in with
 * this computer's login, the one there already (`worksAs`, whom it is) or
 * one made for it; and, where it has settings for that (`allows`), that it
 * lets the tool run quadit without asking.
 */
export function diskLine(
  tool: { name: string; ownLogin: boolean; worksAs: string | null; allows: boolean },
  addsCommand: boolean,
  done: boolean,
): string {
  const things = [
    ...(addsCommand ? ["the quadit command"] : []),
    "the Quadit skill",
    ...(tool.ownLogin ? [done ? "a login file" : "a login file for this tool"] : []),
  ];
  const listed = things.length > 1 ? `${things.slice(0, -1).join(", ")} and ${things.at(-1)}` : things.join("");
  const login = tool.ownLogin
    ? ""
    : tool.worksAs
      ? `; it works as ${tool.worksAs}, this computer’s Quadit login`
      : "; it signs in with this computer’s Quadit login";
  const lets = tool.allows ? `, and ${done ? "let" : "lets"} ${tool.name} run quadit without asking` : "";
  return done
    ? `Added ${listed}${login}${lets}. A backup of everything is kept.`
    : `Adds ${listed}${login}${lets}. Nothing else is touched; a backup is kept.`;
}

/** The computer's default quadit login as a person reads it: "@ann on https://q.example"; null when there is none. */
export function defaultLoginWords(login: { server: string | null; agent: string | null } | null): string | null {
  if (!login) return null;
  return `${login.agent ?? "an agent"}${login.server ? ` on ${login.server}` : ""}`;
}

/**
 * The caution a card shows when a disconnect could not revoke the tool's
 * token: what happened, what the person is to do and where in Quadit (the
 * token by the name it is listed under), and the reason the server gave,
 * which is shown quieter.
 */
export function unrevokedWords(unrevoked: Unrevoked, tool: string): { happened: string; todo: string; reason: string } {
  return {
    happened: `${tool} is disconnected, but its key to this workspace could not be taken back.`,
    todo:
      `To take it back, open Quadit (${unrevoked.server}), go to Settings → Agents → @${unrevoked.agent}, ` +
      `and under Tokens revoke “${unrevoked.label}”.`,
    reason: `The server said: ${unrevoked.reason.replace(/\.?$/, ".")}`,
  };
}

/** What the sheet says first, before the files: what connecting gives the tool. */
export function sheetIntro(tool: string, files: Pick<PlanFile, "role">[]): string {
  return files.some((file) => file.role === "login")
    ? `${tool} gets the Quadit skill, so it knows how to work here, and a login of its own, so what it does shows up as ${tool}, not as you.`
    : `${tool} gets the Quadit skill, so it knows how to work here, and signs in with this computer’s Quadit login.`;
}

/** A file of a plan as the person reads it first: what it is, what it is for, and what happens to it. */
export interface FileWords {
  title: string;
  what: string;
  /** A short tag: "New file", "One line added"… */
  chip: string;
}

/** A file of a plan, for `tool` (its name), in plain words. */
export function fileWords(file: Pick<PlanFile, "role" | "change">, tool: string): FileWords {
  return { ...roleWords(file.role, tool), chip: chipOf(file.role, file.change) };
}

function roleWords(role: FileRole, tool: string): Omit<FileWords, "chip"> {
  switch (role) {
    case "skill":
      return { title: "The Quadit skill", what: `Teaches ${tool} how to find tasks, ask you and report back.` };
    case "login":
      return {
        title: `A login for ${tool}`,
        what: "Its own key to this workspace. You can take it back any time.",
      };
    case "shared-login":
      return {
        title: "This computer’s Quadit login",
        what: `${tool} has no setting for a login of its own, so it uses this one.`,
      };
    case "settings":
      return { title: `${tool}’s settings`, what: `Tells ${tool} how to reach Quadit.` };
    case "command":
      return { title: "The quadit command", what: "Lets your AI tools run quadit, the way they talk to Quadit." };
    case "folder":
      return { title: "A folder for the quadit command", what: "Made in your home folder to hold it." };
    case "profile":
      return { title: "Your terminal’s start-up file", what: "Adds the quadit command’s folder to your PATH." };
    case "rules":
      return { title: `${tool}’s command rules`, what: `Lets ${tool} run quadit without asking you each time.` };
    case "rules-folder":
      return { title: `A folder for ${tool}’s command rules`, what: `Made where ${tool} looks for them.` };
  }
}

function chipOf(role: FileRole, change: FileChange): string {
  switch (change) {
    case "new":
      return role === "folder" || role === "rules-folder" ? "New folder" : role === "command" ? "New link" : "New file";
    // Connecting only ever adds to a file there already: a line, a setting, a table.
    case "edited":
      return role === "profile" ? "One line added" : "Added to";
    case "removed":
      return "Taken away";
    case "restored":
      return "Put back";
    case "shared":
      return "Done already";
  }
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** A count as a word, where it reads better as one: "three"; digits past ten. */
export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** What the sheet's heading says under the tool's name: "Three files in your home folder". */
export function filesSummary(files: Pick<PlanFile, "shown">[]): string {
  const count = files.length;
  const what = `${capitalized(countWord(count))} ${count === 1 ? "file" : "files"}`;
  const home = count > 0 && files.every((file) => file.shown.startsWith("~/"));
  return home ? `${what} in your home folder` : `${what} on this computer`;
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
