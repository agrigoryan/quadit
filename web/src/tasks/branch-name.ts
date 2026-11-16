import type { Task } from "@/types/core";

/** Long enough to say what the branch is for, short enough to type and to read in a list of branches. */
const MOST = 50;

/**
 * A git branch name for a task: its key in small letters, then the title's
 * words ("sva-12-fix-the-login"), cut at a word to stay short. The key
 * leads, so `quadit link` and the GitHub sync find the task in the name.
 * Only plain letters and digits are kept, accents taken off; a title with
 * none gives the key alone.
 */
export function branchName(task: Pick<Task, "key" | "title">): string {
  const words = task.title
    // Each accented letter apart into the letter and its accent, and the accents dropped.
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let name = task.key.toLowerCase();
  for (const word of words) {
    if (name.length + 1 + word.length > MOST) break;
    name += `-${word}`;
  }
  return name;
}
