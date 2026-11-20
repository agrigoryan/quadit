// @vitest-environment jsdom
// Me → Sign-in and security, the password (settings/me/password.tsx): an
// account with no password sets one without being asked for a current one,
// and one with no email either (an install's owner the desktop app made) is
// told why it would want one.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordSection } from "@/settings/me/password";
import { fakeServer } from "@/test/fake-server";

afterEach(() => vi.unstubAllGlobals());

const browserSignIn = "Set an email and a password to sign in from a browser.";

describe("PasswordSection", () => {
  it("sets a first password on an account with no email, with nothing to confirm", async () => {
    const server = fakeServer();
    const sent: unknown[] = [];
    server.post("/api/v1/auth/password", (body: unknown) => {
      sent.push(body);
      return { ok: true };
    });
    const changed = vi.fn();
    render(<PasswordSection hasPassword={false} hasEmail={false} onChanged={changed} />);
    expect(screen.getByText(browserSignIn)).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    await userEvent.type(screen.getByLabelText("New password"), "correct-horse-battery");
    await userEvent.type(screen.getByLabelText("New password, again"), "correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(sent).toEqual([{ current: "", new: "correct-horse-battery" }]);
  });

  it("asks for the current password of an account that has one", () => {
    render(<PasswordSection hasPassword hasEmail onChanged={() => {}} />);
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.queryByText(browserSignIn)).toBeNull();
  });
});
