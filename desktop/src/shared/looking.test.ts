import { describe, expect, it } from "vitest";
import { LOOK_MIN_MS, lookingPace } from "@/shared/looking";

describe("lookingPace", () => {
  it("shares the rest of a second out over the tools, so that looking shows for at least that long", () => {
    expect(lookingPace(8, 200) * 8 + 200).toBe(LOOK_MIN_MS);
    expect(lookingPace(4, 0)).toBe(LOOK_MIN_MS / 4);
  });

  it("adds nothing once looking really took that long, or when there is nothing to go down", () => {
    expect(lookingPace(8, LOOK_MIN_MS)).toBe(0);
    expect(lookingPace(8, 3_000)).toBe(0);
    expect(lookingPace(0, 100)).toBe(0);
  });
});
