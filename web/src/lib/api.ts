// The one place that talks HTTP. Every call is same-origin and carries the
// session cookie. A 401 anywhere means the session ended: the handler set
// with onUnauthorized sends the person to the sign-in page.

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

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
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
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new NetworkError(err);
  }

  // A gateway in front of a stopped server answers 502-504: same as offline.
  if (res.status >= 502 && res.status <= 504) throw new NetworkError();

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: Partial<ApiError> } | undefined)?.error ?? {};
    if (res.status === 401 && !opts.quiet401) unauthorized();
    throw new ApiError(res.status, err);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, { signal }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
  upload: <T>(path: string, file: Blob, contentType?: string) =>
    request<T>("POST", path, { raw: file, contentType }),
};

/** The API path for a workspace: ws("games", "/bootstrap"). */
export const ws = (slug: string, path: string) => `/api/v1/w/${encodeURIComponent(slug)}${path}`;

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
