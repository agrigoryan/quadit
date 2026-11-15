// The server, for tests of what talks to it through lib/api.ts: a `fetch`
// that answers by path. A test says what each path answers, can hold a path's
// answers back to decide when (and whether) each arrives, and can take the
// whole server away.
//
//   const server = fakeServer();
//   server.get("/api/v1/auth/me", { workspaces: [] });
//   server.get("/api/v1/w/acme/me", refuse(403, "suspended"));
//   const rest = server.hold("/api/v1/w/acme/bootstrap?part=rest");
//   ...
//   rest.calls[0]?.answer({ seq: 10 });

import { vi } from "vitest";

/** An answer that is a refusal: the status and the error the server gives with it. */
class Refusal {
  constructor(
    readonly status: number,
    readonly error: { message?: string; code?: string } | undefined,
  ) {}
}

/** The server answers with this status and message (and code, when the app tells refusals apart by it). */
export const refuse = (status: number, message?: string, code?: string) =>
  new Refusal(status, message === undefined && code === undefined ? undefined : { message, code });

/** What a path answers: the value itself (sent as JSON), a `refuse(...)`, or a function of the request's body giving either. */
type Answer = unknown;

/** One request to a held path, waiting for the test to say how it ends. */
export interface HeldCall {
  body: unknown;
  /** True once the app gave the request up. */
  aborted: boolean;
  /** Answers with a value, or with a `refuse(...)`. */
  answer(value: unknown): void;
  /** The request gets no answer at all, as when the server cannot be reached. */
  fail(): void;
}

interface Route {
  method: string;
  path: string | RegExp;
  answer: Answer;
  held: HeldCall[] | null;
}

interface FakeResponse {
  status: number;
  text(): Promise<string>;
}

function respond(value: unknown): FakeResponse {
  const [status, body] = value instanceof Refusal ? [value.status, { error: value.error }] : [200, value];
  return { status, text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)) };
}

export interface FakeServer {
  /** While true no request gets an answer: the server cannot be reached. */
  down: boolean;
  /** Every request made, as "GET /path", in order. */
  requests: string[];
  /** Requests to paths the test said nothing about. A test should end with none. */
  unexpected: string[];
  /** Says what a GET of this path answers from now on: a value, a `refuse(...)`, or a function giving either. */
  get(path: string | RegExp, answer: Answer): void;
  /** The same for POST; a function is given the request's body. */
  post(path: string | RegExp, answer: Answer): void;
  /** Holds back the answers to this path (GET unless said otherwise): each request waits in `calls` for the test. */
  hold(path: string | RegExp, method?: string): { calls: HeldCall[] };
  /** How many requests were made to this path, with any method. */
  count(path: string | RegExp): number;
}

/** Puts a fake `fetch` in place of the real one until `vi.unstubAllGlobals()`. */
export function fakeServer(): FakeServer {
  const routes: Route[] = [];
  const matches = (path: string | RegExp, actual: string) =>
    typeof path === "string" ? path === actual : path.test(actual);
  // The route said last wins, so a test can change what a path answers.
  const find = (method: string, path: string) =>
    routes.findLast((route) => route.method === method && matches(route.path, path));
  const set = (method: string, path: string | RegExp, answer: Answer) =>
    void routes.push({ method, path, answer, held: null });

  const server: FakeServer = {
    down: false,
    requests: [],
    unexpected: [],
    get: (path, answer) => set("GET", path, answer),
    post: (path, answer) => set("POST", path, answer),
    hold(path, method = "GET") {
      const held: HeldCall[] = [];
      routes.push({ method, path, answer: undefined, held });
      return { calls: held };
    },
    count: (path) => server.requests.filter((request) => matches(path, request.slice(request.indexOf(" ") + 1))).length,
  };

  const unreachable = () => new TypeError("Failed to fetch");
  const aborted = () => new DOMException("The operation was aborted.", "AbortError");

  function fakeFetch(input: string, init: RequestInit = {}): Promise<FakeResponse> {
    const method = init.method ?? "GET";
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const signal = init.signal ?? undefined;
    server.requests.push(`${method} ${input}`);
    if (signal?.aborted) return Promise.reject(aborted());
    if (server.down) return Promise.reject(unreachable());
    const route = find(method, input);
    if (!route) {
      server.unexpected.push(`${method} ${input}`);
      return Promise.reject(unreachable());
    }
    if (!route.held) {
      const answer =
        typeof route.answer === "function" ? (route.answer as (b: unknown) => unknown)(body) : route.answer;
      return Promise.resolve(respond(answer));
    }
    const held = route.held;
    return new Promise((resolve, reject) => {
      const call: HeldCall = {
        body,
        aborted: false,
        answer: (value) => resolve(respond(value)),
        fail: () => reject(unreachable()),
      };
      signal?.addEventListener("abort", () => {
        call.aborted = true;
        reject(aborted());
      });
      held.push(call);
    });
  }
  vi.stubGlobal("fetch", fakeFetch);
  return server;
}
