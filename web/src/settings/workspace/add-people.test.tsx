// @vitest-environment jsdom
// Add people (settings/workspace/add-people.tsx): each of its selects is named by its field.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { useStore } from "@/lib/store";
import type { Member } from "@/lib/types";
import { AddPeopleDialog } from "@/settings/workspace/add-people";
import { TooltipProvider } from "@/ui/tooltip";

beforeAll(() => {
  useStore.setState({ slug: "test", me: { user_id: "u", role: "owner" } as Member });
});

describe("AddPeopleDialog", () => {
  it("names the role, expiry and uses selects", () => {
    render(
      <TooltipProvider>
        <AddPeopleDialog onClose={() => {}} onCreated={() => {}} onAdded={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Role" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Good for" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Invite link" }));
    expect(screen.getByRole("combobox", { name: "Can be used" })).toBeInTheDocument();
  });
});
