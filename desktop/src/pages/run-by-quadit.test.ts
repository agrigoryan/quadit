import { describe, expect, it } from "vitest";
import {
  blockedLine,
  choosingNote,
  entryLine,
  mayStart,
  noOwnerLine,
  offerLine,
  statusLine,
  unreadableLine,
  untilWords,
} from "@/pages/run-by-quadit";
import type { RunEntryView } from "@/shared/pages-api";

const CLAUDE = { program: "Claude Code", here: "this Mac" };
const CODEX = { program: "Codex", here: "this computer" };
const ME = { handle: "ann", me: true };
const BOB = { handle: "bob", me: false };

function entry(status: RunEntryView["status"]): RunEntryView {
  return { id: "e5d2a91c", project: "SVA", folder: "~/devel/game", program: "claude", status, blocked: [] };
}

describe("Run by Quadit's words", () => {
  it("says what Quadit would do before it runs any project", () => {
    expect(offerLine(CLAUDE, "@claude", ME)).toBe(
      "Quadit can start Claude Code for you when you assign @claude a task or comment on one, in the project’s folder on this Mac.",
    );
    expect(offerLine(CODEX, "@codex", ME)).toBe(
      "Quadit can start Codex for you when you assign @codex a task or comment on one, in the project’s folder on this computer.",
    );
  });

  it("names the person who answers for the agent when it is someone else, and its account as this person's", () => {
    expect(offerLine(CLAUDE, "@claude", BOB)).toBe(
      "Quadit can start Claude Code under your account when @bob assigns @claude a task or writes to it on one, in the project’s folder on this Mac.",
    );
    expect(choosingNote(CLAUDE, "@claude", "SVA", BOB)).toBe(
      "Claude Code runs there with full access, under your account on this Mac, whenever @bob assigns @claude a task in SVA or writes to it on one. Only @bob’s words, or those of @bob’s other agents, start it.",
    );
  });

  it("says why nothing is offered, or shown", () => {
    expect(noOwnerLine("@claude")).toBe("Quadit cannot tell who answers for @claude, so it does not offer to run it.");
    expect(unreadableLine(CODEX)).toBe(
      "Quadit could not read which projects it runs on this computer. It tries again in a moment.",
    );
  });

  it("says, while choosing, what running there means and whose words start it", () => {
    expect(choosingNote(CLAUDE, "@claude", "SVA", ME)).toBe(
      "Claude Code runs there with full access, as you, whenever you assign @claude a task in SVA or comment on one. Only your words, or those of your other agents, start it.",
    );
    expect(choosingNote(CLAUDE, "@claude", null, ME)).toContain("a task in the project or comment on one.");
  });

  it("lets Start running be pressed only with a project and a folder chosen, and nothing under way", () => {
    expect(mayStart({ project: "", folder: null, busy: false })).toBe(false);
    expect(mayStart({ project: "SVA", folder: null, busy: false })).toBe(false);
    expect(mayStart({ project: "", folder: "/Users/lou/devel/game", busy: false })).toBe(false);
    expect(mayStart({ project: "SVA", folder: "/Users/lou/devel/game", busy: true })).toBe(false);
    expect(mayStart({ project: "SVA", folder: "/Users/lou/devel/game", busy: false })).toBe(true);
  });

  it("says what each project runs in, and what it does now, in each state", () => {
    expect(entryLine(entry({ state: "ready" }))).toBe("Runs SVA in ~/devel/game.");
    const cases: [RunEntryView["status"], string][] = [
      [{ state: "starting" }, "Starting…"],
      [{ state: "ready" }, "Ready."],
      [{ state: "working", task: "SVA-12" }, "Working on SVA-12."],
      [{ state: "paused", pause: "usage_limit" }, "Paused: Claude Code’s usage limit."],
      [
        { state: "paused", pause: "not_signed_in" },
        "Paused: Claude Code is not signed in. Open Claude Code and sign in.",
      ],
      [{ state: "paused", pause: "program_missing" }, "Paused: Claude Code was not found on this Mac."],
      [{ state: "paused", pause: "folder_missing" }, "Paused: the folder is gone. Stop running and pick it again."],
      [
        { state: "paused", pause: "login_mismatch" },
        "Paused: Claude Code is set to work as another agent. Connect it again.",
      ],
      [{ state: "paused", pause: "server_old" }, "Paused: this server needs an update to run agents."],
      [{ state: "aside" }, "A chat listens to SVA now. Quadit runs it again when that chat stops."],
      [{ state: "removing" }, "Stopping…"],
      [{ state: "error", message: "login refused" }, "Not running: login refused"],
      [
        { state: "not_served", message: "Another quadit run serves this computer." },
        "Another quadit run serves this computer.",
      ],
    ];
    for (const [status, said] of cases) expect(statusLine(CLAUDE, entry(status))).toBe(said);
  });

  it("says until when a usage limit holds, the day added when it is not today", () => {
    const now = new Date(2026, 10, 24, 14, 5);
    const today = new Date(2026, 10, 24, 18, 0);
    const time = today.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(untilWords(today.toISOString(), now)).toBe(time);
    expect(statusLine(CODEX, entry({ state: "paused", pause: "usage_limit", until: today.toISOString() }), now)).toBe(
      `Paused until ${time}: Codex’s usage limit.`,
    );
    const tomorrow = new Date(2026, 10, 25, 9, 30);
    expect(untilWords(tomorrow.toISOString(), now)).toBe(
      `${tomorrow.toLocaleDateString(undefined, { weekday: "short" })} ${tomorrow.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    );
    expect(untilWords("soon", now)).toBe("soon");
  });

  it("says a write about a run the server refused for good", () => {
    expect(blockedLine({ task: "SVA-11", error: "forbidden: you may not" })).toBe(
      "Quadit could not record how a run on SVA-11 ended (forbidden: you may not).",
    );
  });
});
