// @vitest-environment jsdom
// The Backups page (admin/backups.tsx): where each backup is also copied is
// one choice with the fields its kind needs, and each archive says whether
// its copy got there.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminKeys } from "@/admin/data";
import { BackupsPage } from "@/admin/backups";
import { MASK, type SettingsMap } from "@/admin/settings";
import { noBucket } from "@/admin/bucket";
import { queryClient } from "@/data/query";
import { type FakeServer, fakeServer } from "@/test/fake-server";
import { WithQuery } from "@/test/query";
import { TooltipProvider } from "@/ui/tooltip";

let server: FakeServer;

beforeAll(() => {
  // The daily switch measures itself; jsdom does not.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  server = fakeServer();
  server.get("/api/v1/admin/backups", { backups: [], directory: "/data/backups" });
});

afterEach(() => vi.unstubAllGlobals());

const open = (settings: SettingsMap = {}) => {
  queryClient.setQueryData(adminKeys.settings, settings);
  render(
    <MemoryRouter>
      <TooltipProvider>
        <BackupsPage />
      </TooltipProvider>
    </MemoryRouter>,
    { wrapper: WithQuery },
  );
};

const copyTo = () => screen.getByLabelText("Also copy each backup to");
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("where each backup is also copied", () => {
  it("asks a folder for its path, and sends it with every bucket secret forgotten", async () => {
    open();
    const put = server.hold("/api/v1/admin/settings/backup", "PUT");
    expect(screen.queryByLabelText("Folder")).toBeNull();
    fireEvent.change(copyTo(), { target: { value: "folder" } });
    save();
    expect(await screen.findByText("This is required")).toBeInTheDocument();
    expect(put.calls).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: " /mnt/backups " } });
    save();
    await waitFor(() => expect(put.calls).toHaveLength(1));
    expect(put.calls[0]?.body).toMatchObject({
      copy_to: { kind: "folder", folder: "/mnt/backups", bucket: { kind: "disk", secret_key: "", account_key: "" } },
    });
  });

  it("asks a bucket for what its kind needs, and keeps a stored secret", async () => {
    const bucket = { ...noBucket, kind: "s3", bucket: "backups", access_key: "AK", secret_key: MASK };
    open({
      backup: {
        value: { enabled: true, hour: 3, keep: 7, copy_to: { kind: "bucket", folder: "", bucket } },
        from_env: false,
      },
    });
    const put = server.hold("/api/v1/admin/settings/backup", "PUT");
    expect(copyTo()).toHaveValue("s3");
    expect(screen.getByLabelText("Secret key")).toHaveValue("");

    fireEvent.change(copyTo(), { target: { value: "azure" } });
    expect(screen.getByLabelText("Container")).toHaveValue("backups");
    save();
    expect(await screen.findAllByText("This is required")).toHaveLength(2); // the account and its key

    fireEvent.change(copyTo(), { target: { value: "s3" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "eu-west-1" } });
    save();
    await waitFor(() => expect(put.calls).toHaveLength(1));
    expect(put.calls[0]?.body).toMatchObject({
      enabled: true,
      keep: 7,
      copy_to: {
        kind: "bucket",
        folder: "",
        bucket: { kind: "s3", bucket: "backups", region: "eu-west-1", secret_key: MASK },
      },
    });
  });
});

describe("an archive's copy", () => {
  it("is marked copied, or not copied with why", async () => {
    server.get("/api/v1/admin/backups", {
      directory: "/data/backups",
      backups: [
        {
          id: "b2",
          started_at: 2,
          finished_at: 3,
          verified_at: 3,
          size: 10,
          location: "/data/backups/quadit-2.tar.gz",
          copy_error: "the folder /mnt/backups: no such file or directory",
        },
        {
          id: "b1",
          started_at: 1,
          finished_at: 2,
          verified_at: 2,
          size: 10,
          location: "/data/backups/quadit-1.tar.gz",
          copied_at: 2,
        },
      ],
    });
    open();
    const failed = (await screen.findByText(/the folder \/mnt\/backups/)).closest("div");
    expect(failed).not.toBeNull();
    expect(within(failed as HTMLElement).getByText("Not copied")).toBeInTheDocument();
    const copied = screen.getByText("quadit-1.tar.gz").closest("div");
    expect(within(copied as HTMLElement).getByText("Copied")).toBeInTheDocument();
  });
});
