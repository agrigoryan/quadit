// What connecting a tool changes, in the words of someone who is not
// technical (desktop contract §10): the line on a tool's card, and, in "See
// the files", each file by what it is for, a sentence, and what happens to
// it. The words come from what the tool is and the kind of change the plan
// makes to each file (PlanFile's role and change), never from reading a
// diff, which stays behind "Show the exact changes".

import type { FileChange, FileRole, PlanFile } from "@/shared/pages-api";

/**
 * The line on a tool's card saying what connecting changes on disk (`done`:
 * what it changed): the quadit command when the computer has none on its
 * PATH yet (`addsCommand`), the skill, and the tool's own login where it can
 * have one (`ownLogin`), else this computer's.
 */
export function diskLine(tool: { ownLogin: boolean }, addsCommand: boolean, done: boolean): string {
  const things = [
    ...(addsCommand ? ["the quadit command"] : []),
    "the Quadit skill",
    ...(tool.ownLogin ? [done ? "a login file" : "a login file for this tool"] : []),
  ];
  const listed = things.length > 1 ? `${things.slice(0, -1).join(", ")} and ${things.at(-1)}` : things.join("");
  const login = tool.ownLogin ? "" : "; it signs in with this computer’s Quadit login";
  return done
    ? `Added ${listed}${login}. A backup of everything is kept.`
    : `Adds ${listed}${login}. Nothing else is touched; a backup is kept.`;
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
  }
}

function chipOf(role: FileRole, change: FileChange): string {
  switch (change) {
    case "new":
      return role === "folder" ? "New folder" : role === "command" ? "New link" : "New file";
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
