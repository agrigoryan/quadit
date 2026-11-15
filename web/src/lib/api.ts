// The one place that talks HTTP. Every call is same-origin and carries the
// session cookie. A 401 anywhere means the session ended: the handler set
// with onUnauthorized sends the person to the sign-in page.
//
// Because every call passes through here, this is also where it is known
// whether the server can be reached, and where the one rule for trying again
// lives: whenReachable.

/** A refusal from the server, in the one shape every error has. */
export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  allowed?: string[];
  nearest?: string;
  index?: number;

  constructor(status: number, body: Partial<ApiError> & { message?: string }) {
    super(body.message ?? `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code ?? "error";
    this.field = body.field;
    this.allowed = body.allowed;
    this.nearest = body.nearest;
    this.index = body.index;
  }
}

/** The request never got an answer: offline, or the server is down. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("the server could not be reached");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

let unauthorized: () => void = () => {};

export function onUnauthorized(handler: () => void) {
  unauthorized = handler;
}

interface RequestOptions {
  body?: unknown;
  /** Send this as the raw body (a file) instead of JSON. */
  raw?: Blob;
  contentType?: string;
  signal?: AbortSignal;
  /** Sign-in calls answer 401 for a wrong password; that is not a lost session. */
  quiet401?: boolean;
}

const request = <T>(method: string, path: string, opts: RequestOptions = {}) =>
  noted(fetchAnswer<T>(method, path, opts));

async function fetchAnswer<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (opts.raw) {
    body = opts.raw;
    headers["Content-Type"] = opts.contentType || opts.raw.type || "application/octet-stream";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, signal: opts.signal, credentials: "same-origin" });
  } catch (err) {
    if (calledOff(err, opts.signal)) throw err;
    throw new NetworkError(err);
  }

  // A gateway in front of a stopped server answers 502-504: same as offline.
  if (res.status >= 502 && res.status <= 504) throw new NetworkError();

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // The connection went away while the answer was arriving.
    if (calledOff(err, opts.signal)) throw err;
    throw new NetworkError(err);
  }
  return answer<T>(res.status, text, opts.quiet401);
}

/**
 * Whether a failed request was called off by its signal, which is no sign
 * of the network. Known by its name, not by `instanceof DOMException`: an abort
 * from another realm (an iframe, jsdom) is another realm's DOMException.
 */
export const calledOff = (err: unknown, signal?: AbortSignal) =>
  !!signal?.aborted || (err instanceof Object && "name" in err && err.name === "AbortError");

/** Turns a status and a body into the result, or throws the error they mean. */
function answer<T>(status: number, text: string, quiet401?: boolean): T {
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (status < 200 || status >= 300) {
    const err = (data as { error?: Partial<ApiError> } | undefined)?.error;
    // The server always says why it refused. A 5xx without a reason came from
    // something in front of it (a proxy whose server is away): same as offline.
    if (status >= 500 && !err) throw new NetworkError();
    if (status === 401 && !quiet401) unauthorized();
    throw new ApiError(status, err ?? {});
  }
  return data as T;
}

interface SendOptions {
  contentType?: string;
  signal?: AbortSignal;
  /** Called as the bytes leave, with how many of this request's have gone. */
  onProgress?: (sent: number) => void;
}

/**
 * Sends raw bytes (a file, or one part of one) and reports how far it has
 * got, which fetch cannot do. Errors are the same as for every other call.
 */
const sendBytes = <T>(method: string, path: string, bytes: Blob, opts: SendOptions = {}) =>
  noted(sendWithProgress<T>(method, path, bytes, opts));

function sendWithProgress<T>(method: string, path: string, bytes: Blob, opts: SendOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", opts.contentType || bytes.type || "application/octet-stream");
    const abort = () => xhr.abort();
    const done = () => opts.signal?.removeEventListener("abort", abort);
    if (opts.onProgress) {
      const report = opts.onProgress;
      xhr.upload.onprogress = (e) => report(e.loaded);
    }
    xhr.onload = () => {
      done();
      if (xhr.status >= 502 && xhr.status <= 504) return reject(new NetworkError());
      try {
        resolve(answer<T>(xhr.status, xhr.responseText));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => {
      done();
      reject(new NetworkError());
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      done();
      reject(new DOMException("aborted", "AbortError"));
    };
    if (opts.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    opts.signal?.addEventListener("abort", abort);
    xhr.send(bytes);
  });
}

// ---- whether the server can be reached, and when to try again ----

/** True from a call that got no answer until the server is next heard from. */
let away = false;
/** The waits of whenReachable under way; calling one ends it. */
const waits = new Set<() => void>();
const backAgainListeners = new Set<() => void>();

/** Notes how a call ended (an answer, even a refusal, means the server is there) and passes its outcome on. */
async function noted<T>(call: Promise<T>): Promise<T> {
  try {
    const result = await call;
    heardFromServer();
    return result;
  } catch (err) {
    if (err instanceof NetworkError) away = true;
    else if (err instanceof ApiError) heardFromServer();
    throw err;
  }
}

function heardFromServer() {
  if (!away) return;
  noteReachable();
  for (const listener of [...backAgainListeners]) listener();
}

/**
 * Says the server was reached by other means than a call here (the live
 * stream opened): whoever waits in whenReachable tries again now.
 */
export function noteReachable() {
  away = false;
  for (const end of [...waits]) end();
}

/**
 * Hear when a call gets an answer after one that got none: the server was
 * away and is back. (Not called for noteReachable: whoever says that knows.)
 */
export function onReachableAgain(listener: () => void): () => void {
  backAgainListeners.add(listener);
  return () => backAgainListeners.delete(listener);
}

/** The first wait before trying again; each one after is twice as long, up to the longest. */
const RETRY_FIRST_MS = 1000;
const RETRY_LONGEST_MS = 15_000;

/** How long whenReachable waits at most before try number `attempt` (from 0): its timer, without the reasons to end early. */
export function retryWait(attempt: number): number {
  const longest = Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_LONGEST_MS);
  return longest / 2 + Math.random() * (longest / 2);
}

/**
 * Waits until it is worth trying again something the server could not be
 * reached for. `attempt` counts the tries in a row that failed before this
 * wait, from 0: the wait is about 1 s, 2 s, 4 s, 8 s, then 15 s each time,
 * shortened at random by up to half so that everything cut off by one outage
 * does not come back in the same instant. It ends early as soon as there is
 * reason to think the server is back: the browser comes online, a call gets
 * an answer, or the live stream opens. Rejects with the signal's reason if
 * `signal` is aborted first.
 */
export function whenReachable(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(end, retryWait(attempt));
    const browser = typeof window === "undefined" ? undefined : window;
    function end() {
      clearTimeout(timer);
      waits.delete(end);
      browser?.removeEventListener("online", end);
      signal?.removeEventListener("abort", end);
      if (signal?.aborted) reject(signal.reason);
      else resolve();
    }
    waits.add(end);
    browser?.addEventListener("online", end);
    signal?.addEventListener("abort", end);
  });
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, { signal }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
  upload: <T>(path: string, file: Blob, contentType?: string) => request<T>("POST", path, { raw: file, contentType }),
  /** Sends bytes with POST or PATCH, reporting progress (lib/files.ts sends a file in parts with it). */
  send: sendBytes,
};

/** The API path for a workspace: workspacePath("games", "/bootstrap"). */
export const workspacePath = (slug: string, path: string) => `/api/v1/w/${encodeURIComponent(slug)}${path}`;

/** The message to show for anything a call can throw. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.nearest) return `${err.message} (did you mean ${err.nearest}?)`;
    if (err.allowed?.length) return `${err.message} (allowed: ${err.allowed.join(", ")})`;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
