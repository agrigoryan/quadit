// @vitest-environment jsdom
// The avatar (ui/avatar.tsx): an agent's badge sits on the picture's own box.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "@/ui/avatar";

afterEach(cleanup);

describe("Avatar", () => {
  it("keeps an agent's badge on the picture when its row stretches its children", () => {
    const { container } = render(
      <div className="flex">
        <Avatar member={{ user_id: "a1", name: "Claude", kind: "agent", avatar: "" }} size="xs" />
      </div>,
    );
    const wrapper = container.querySelector("[title='Claude']");
    const picture = wrapper?.querySelector("[aria-hidden]");
    const badge = wrapper?.querySelector(".absolute");
    expect(badge).toBeTruthy();
    // The badge is placed against the wrapper, so the wrapper must be exactly the picture's size.
    const size = [...(picture?.classList ?? [])].find((c) => c.startsWith("size-"));
    expect(size).toBeTruthy();
    expect(wrapper?.classList.contains(size!)).toBe(true);
  });

  it("draws a member's initials on the tint it was given, and one without on a tint of its id", () => {
    const ground = (tint?: number) => {
      const { container } = render(<Avatar member={{ user_id: "u1", name: "Ann Lee", kind: "person", tint }} />);
      const letters = container.querySelector<HTMLElement>("[aria-hidden]");
      cleanup();
      return letters?.style.background;
    };
    expect(ground(1)).toBe("rgb(3, 122, 192)");
    expect(ground(2)).toBe("rgb(167, 102, 22)");
    expect(ground(undefined)).toBe(ground(undefined));
    expect(ground(undefined)).toMatch(/^rgb\(/);
  });

  it("draws a picture or an emoji, not a tint", () => {
    const { container } = render(
      <Avatar member={{ user_id: "u1", name: "Ann", kind: "person", avatar: "🦊", tint: 3 }} />,
    );
    expect(container.querySelector<HTMLElement>("[aria-hidden]")?.style.background).toBe("");
  });
});
