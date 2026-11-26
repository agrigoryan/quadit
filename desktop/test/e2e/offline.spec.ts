import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desktop, expect, test } from "./desktop";

/** A port nothing listens on, for now. */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** The real server, reachable at `port` from now on: a server coming back. */
function comeBack(port: number, real: string): Promise<Server> {
  const proxy = createServer((req, res) => {
    const target = new URL(req.url ?? "/", real);
    const upstream = request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  return new Promise((done) => proxy.listen(port, "127.0.0.1", () => done(proxy)));
}

test("a server that cannot be reached says so with a retry, and loads once it is back and the computer wakes", async ({
  run,
}) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "quadit-desktop-app-"));
  writeFileSync(
    join(data, "servers.json"),
    JSON.stringify({ servers: [{ id: "0a1b2c3d4e5f", name: "Away", origin, open: true, handoff: 1 }] }),
  );
  const desktop = await Desktop.launch(data, run);
  let proxy: Server | undefined;
  try {
    const error = await desktop.appPage("connection-error.html");
    await expect(error.getByRole("heading", { name: "Away cannot be reached" })).toBeVisible();
    await expect(error.getByText(origin)).toBeVisible();
    // Retrying while it is still away: still the same page.
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(error.getByRole("heading", { name: "Away cannot be reached" })).toBeVisible();

    // Back, and the computer wakes: the window loads it at once.
    proxy = await comeBack(port, run.direct);
    await desktop.app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    const page = await desktop.pageOf(origin);
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
    // The error page is gone (the sign-in bar may show over the sign-in page in its place).
    await expect
      .poll(() => desktop.app.windows().some((p) => p.url().includes("/connection-error.html")), { timeout: 5000 })
      .toBe(false);
  } finally {
    await desktop.close();
    proxy?.close();
  }
});

test("waking the computer nudges each server's page to check its live stream", async ({ desktop, run }) => {
  await desktop.addServer(run.server);
  const page = await desktop.signedIn(run.server);
  await page.evaluate(() => {
    Object.assign(window, { onlineHeard: 0 });
    addEventListener("online", () => (window as unknown as { onlineHeard: number }).onlineHeard++);
  });
  await desktop.app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  await expect.poll(() => page.evaluate(() => (window as unknown as { onlineHeard: number }).onlineHeard)).toBe(1);
});
