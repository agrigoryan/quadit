// @vitest-environment jsdom
// The second step of signing in (auth/second-step.tsx) offers the ways the
// person has: a code from their app, their passkey, or both.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecondStep } from "@/auth/second-step";
import type { SecondStepWays } from "@/auth/session";
import { api } from "@/data/api";
import { WithQuery } from "@/test/query";

vi.mock("@/auth/webauthn", async (real) => ({
  ...(await real<typeof import("@/auth/webauthn")>()),
  passkeysSupported: () => true,
}));

let ways: SecondStepWays;

beforeEach(() => {
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path === "/api/v1/auth/second-step") return Promise.resolve(ways);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

afterEach(() => void vi.restoreAllMocks());

const show = () => render(<SecondStep />, { wrapper: WithQuery });

describe("SecondStep", () => {
  it("asks a person with only a passkey for it, and for no code", async () => {
    ways = { code: false, passkey: true };
    show();
    expect(await screen.findByRole("button", { name: "Sign in with a passkey" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use a recovery code instead" })).not.toBeInTheDocument();
  });

  it("asks a person with an app for its code, with no passkey to use when they have none", async () => {
    ways = { code: true, passkey: false };
    show();
    expect(await screen.findByLabelText("Code")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).not.toBeInTheDocument();
  });
});
