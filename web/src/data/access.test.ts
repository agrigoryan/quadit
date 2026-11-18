// What a member may do (data/access.ts), against the server's rules: each
// kind of member, each question.

import { describe, expect, it } from "vitest";
import { can } from "@/data/access";
import type { Member } from "@/types/core";

const member = (over: Partial<Member>): Member =>
  ({ user_id: "me", role: "member", kind: "person", name: "Me", handle: "me", ...over }) as Member;

const who = {
  owner: member({ role: "owner" }),
  admin: member({ role: "admin" }),
  member: member({}),
  readOnly: member({ scope: { read_only: true } }),
  readOnlyAdmin: member({ role: "admin", scope: { read_only: true } }),
  limited: member({ scope: { projects: ["p1"] } }),
  suspended: member({ suspended_at: 1 }),
};

/** Each member's answers: write, edit in p1, edit in p2, edit the workspace's own, change their own, change another's, administer, own, change a task in p1. */
const table: [keyof typeof who, boolean[]][] = [
  ["owner", [true, true, true, true, true, true, true, true, true]],
  ["admin", [true, true, true, true, true, true, true, false, true]],
  ["member", [true, true, true, true, true, false, false, false, true]],
  ["readOnly", [false, false, false, false, false, false, false, false, false]],
  ["readOnlyAdmin", [false, false, false, false, false, false, false, false, false]],
  ["limited", [true, true, false, true, true, false, false, false, true]],
  ["suspended", [false, false, false, false, false, false, false, false, false]],
];

describe("can", () => {
  it.each(table)("%s", (name, want) => {
    const access = can(who[name]);
    expect([
      access.write,
      access.edit("p1"),
      access.edit("p2"),
      access.edit(),
      access.editMadeBy("me", "p1"),
      access.editMadeBy("someone-else", "p1"),
      access.administer,
      access.own,
      access.editTask({ project_id: "p1" }),
    ]).toEqual(want);
  });

  it("an agent's tokens are an admin's, and the person's who answers for it", () => {
    expect(can(who.admin).agentTokens({ responsible_id: "someone-else" })).toBe(true);
    expect(can(who.member).agentTokens({ responsible_id: "me" })).toBe(true);
    expect(can(who.member).agentTokens({ responsible_id: "someone-else" })).toBe(false);
    expect(can(who.readOnly).agentTokens({ responsible_id: "me" })).toBe(false);
  });

  it("nobody may change a task in the trash, or one in a project outside their reach", () => {
    expect(can(who.owner).editTask({ project_id: "p1", deleted_at: 5 })).toBe(false);
    expect(can(who.limited).editTask({ project_id: "p2" })).toBe(false);
  });

  it("a limited member may not change their own thing in a project outside their reach", () => {
    expect(can(who.limited).editMadeBy("me", "p2")).toBe(false);
  });

  it("no one signed in: nothing may be done", () => {
    const access = can(null);
    expect([access.write, access.edit(), access.editMadeBy("me"), access.administer, access.own]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
