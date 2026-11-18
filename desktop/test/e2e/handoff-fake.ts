// A stand-in for the server side of the desktop contract until the server
// has it: a proxy in front of a real Quadit server that answers
// /api/v1/version and the sign-in hand-off (/desktop/connect and
// /desktop/finish) as the contract says, and passes everything else to the
// real server untouched (the web app, the API, the live feed).
//
// Two shortcuts, both where a test stands in for a person anyway: connect
// does not ask "Sign in to the Quadit app as …?" but answers at once, and
// finish makes its session by signing in to the real server with the
// owner's password. The checks the app depends on are real: the code is
// single use and bound to the challenge and state, finish refuses a
// verifier whose SHA-256 is not the challenge, and it answers only a load
// that carries the hand-off header.
//
// GET /__fake/log gives what happened, for the tests to check,
// GET /__fake/handoff?version=N changes the hand-off version it says it
// speaks (an upgraded server), GET /__fake/agents the user agents of the requests it passed on (who
// loaded pages through it), and GET /__fake/provider redirects to another
// site, as a sign-in provider's start does.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";

export interface HandoffEvent {
  step: "connect" | "finish";
  ok: boolean;
  detail: string;
}

export function startHandoffFake(
  real: string,
  owner: { email: string; password: string },
): Promise<{ url: string; close(): Promise<void> }> {
  const codes = new Map<string, { challenge: string; state: string; used: boolean; at: number }>();
  const log: HandoffEvent[] = [];
  const agents = new Set<string>();
  let handoff = 1;
  let self = "";

  const answer = (
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string | string[]> = {},
  ) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", self);
    if (url.pathname === "/api/v1/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "quadit", version: "e2e-fake", surface: "fake", desktop: { handoff } }));
      return;
    }
    if (url.pathname === "/__fake/handoff") {
      handoff = Number(url.searchParams.get("version"));
      return answer(res, 204, "");
    }
    if (url.pathname === "/__fake/log") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(log));
      return;
    }
    if (url.pathname === "/__fake/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([...agents]));
      return;
    }
    if (url.pathname === "/__fake/provider") {
      return answer(res, 302, "", { location: "https://accounts.example.com/o/oauth2/auth?client_id=x" });
    }
    if (url.pathname === "/desktop/connect") {
      const state = url.searchParams.get("state") ?? "";
      const challenge = url.searchParams.get("challenge") ?? "";
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        log.push({ step: "connect", ok: false, detail: "bad request" });
        return answer(res, 400, "Try again from the app.");
      }
      const code = randomBytes(16).toString("base64url");
      codes.set(code, { challenge, state, used: false, at: Date.now() });
      log.push({ step: "connect", ok: true, detail: state });
      const back = new URL("quadit://connect");
      back.searchParams.set("server", self);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      return answer(res, 302, "", { location: back.href });
    }
    if (url.pathname === "/desktop/finish") {
      // Only the app's own hand-off carries the header (the contract, section 2).
      if (req.headers["x-quadit-handoff"] !== "1") {
        log.push({ step: "finish", ok: false, detail: "not the app's hand-off" });
        return answer(res, 403, "Open this in the Quadit app.");
      }
      void finish(url, res);
      return;
    }
    proxy(req, res);
  });

  async function finish(url: URL, res: ServerResponse) {
    const code = codes.get(url.searchParams.get("code") ?? "");
    const verifier = url.searchParams.get("verifier") ?? "";
    const fail = (detail: string) => {
      log.push({ step: "finish", ok: false, detail });
      answer(res, 400, "This sign-in did not work. Try again from the app.");
    };
    if (!code || code.used || Date.now() - code.at > 120_000) return fail("unknown, used or expired code");
    code.used = true;
    if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge)
      return fail("verifier does not match");
    const signedIn = await fetch(`${real}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    const cookies = signedIn.headers.getSetCookie();
    if (!signedIn.ok || cookies.length === 0) return fail(`real sign-in: ${signedIn.status}`);
    log.push({ step: "finish", ok: true, detail: code.state });
    answer(res, 302, "", { location: "/", "set-cookie": cookies });
  }

  function proxy(req: IncomingMessage, res: ServerResponse) {
    agents.add(req.headers["user-agent"] ?? "");
    const target = new URL(req.url ?? "/", real);
    const upstream = request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (answered) => {
        res.writeHead(answered.statusCode ?? 502, answered.headers);
        answered.pipe(res);
      },
    );
    upstream.on("error", () => answer(res, 502, "the real server did not answer"));
    req.pipe(upstream);
  }

  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      self = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      ready({
        url: self,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}
