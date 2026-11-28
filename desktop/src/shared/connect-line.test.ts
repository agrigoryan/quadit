import { describe, expect, it } from "vitest";
import { connectLine } from "@/shared/connect-line";

describe("connectLine", () => {
  it("names the workspace the code is for, so an agent in several gives it there alone", () => {
    expect(connectLine("K7PQ2M", "Acme")).toBe("Connect to Quadit K7PQ2M in Acme");
    expect(connectLine("K7PQ2M", "")).toBe("Connect to Quadit K7PQ2M");
  });
});
