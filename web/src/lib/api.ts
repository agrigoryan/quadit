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

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // The connection went away while the answer was arriving.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new NetworkError(err);
  }
  return answer<T>(res.status, text, opts.quiet401);
}

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

export interface SendOptions {
  contentType?: string;
  signal?: AbortSignal;
  /** Called as the bytes leave, with how many of this request's have gone. */
  onProgress?: (sent: number) => void;
}

/**
 * Sends raw bytes (a file, or one part of one) and reports how far it has
 * got, which fetch cannot do. Errors are the same as for every other call.
 */
function sendBytes<T>(method: string, path: string, bytes: Blob, opts: SendOptions = {}): Promise<T> {
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

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, { signal }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
  upload: <T>(path: string, file: Blob, contentType?: string) =>
    request<T>("POST", path, { raw: file, contentType }),
  /** Sends bytes with POST or PATCH, reporting progress (lib/files.ts sends a file in parts with it). */
  send: sendBytes,
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
