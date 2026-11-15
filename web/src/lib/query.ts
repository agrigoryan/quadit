// Reads of what the workspace copy (lib/store.ts) does not hold: settings
// lists, an opened task's history, a page's blocks, the trash, the admin
// pages. They go through TanStack Query; this file is the one client and
// every rule it runs on. A feature names its keys in its data.ts and says
// what to fetch; a fetch that brings rows the store keeps (an opened task,
// trashed rows) hands them to the store inside its queryFn and caches only
// what the store does not hold.
//
// The rules, and why:
// - Stale at once (staleTime 0): a page that opens asks again, as the app
//   always has, and shows the answer it had meanwhile. Reads that follow the
//   feed are asked again by the feed (lib/live.ts).
// - Not again on window focus: what changes behind a page's back reaches it
//   through the feed, or when the stream comes back.
// - Tried again only when the server could not be reached (NetworkError), a
//   few times, waiting as whenReachable does. A refusal, a 4xx or a 5xx the
//   server explained, is the answer: asking again gets the same one. A 401
//   has already sent the person to sign in, and a read that got one shows
//   nothing (readError).
// - The server counts as there while the workspace's live stream is not down
//   and the browser is online. A workspace's read (its key starts with
//   inWorkspace) that starts or must try again while it is not waits, and
//   every read on screen is asked again when it is back: it may have missed a
//   change meanwhile. Reads outside a workspace (the account, the admin pages)
//   have no stream to wait for: they go out at once and fail as they fail.
// - Writes (useMutation) are never held back: one made while the server is
//   away fails at once and says so.
// - When the copy is replaced (another workspace, the person's access
//   changed) the workspace's reads are dropped and those on screen asked
//   again; at sign-out, or when the workspace is lost, every read goes.

import { onlineManager, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError, errorMessage, NetworkError, retryWait } from "@/lib/api";
import { getState, onReplaced, useStore } from "@/lib/store";
import { type Key, t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

/** How many times a read the server did not answer is tried again before it shows as failed. */
const UNREACHABLE_RETRIES = 3;

/** Try again a read the server did not answer; never one it refused. */
export const retryUnreachable = (failures: number, err: unknown) =>
  err instanceof NetworkError && failures < UNREACHABLE_RETRIES;

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /**
       * A read whose failure would otherwise go unseen (nothing on screen
       * waits for it) says so in a toast: this message, with `{why}`.
       */
      failureToast?: Key;
    };
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(err, query) {
      const message = query.meta?.failureToast;
      if (message && readError(err) && !isNotFound(err)) toast.error(t(message, { why: errorMessage(err) }));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: "always",
      retry: retryUnreachable,
      retryDelay: retryWait,
      networkMode: "always",
    },
    mutations: { retry: false, networkMode: "always" },
  },
});

/** The start of the key of every read in a workspace: it waits for the stream, and goes with the copy. */
export const inWorkspace = (slug: string) => ["w", slug] as const;

queryClient.setQueryDefaults(["w"], { networkMode: "online" });

/** True when the server said there is no such thing (or none this person may see). */
export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

/** What to say for a failed read: the reason, or "" after a 401, which has already sent the person to sign in. */
export function readError(err: unknown): string {
  if (!err || (err instanceof ApiError && err.status === 401)) return "";
  return errorMessage(err);
}

// The client lives as long as the page, not as long as whatever renders it:
// it follows the stream even while no provider is mounted.
queryClient.mount();

onlineManager.setEventListener((setOnline) => {
  const browser = typeof window === "undefined" ? undefined : window;
  const update = () => setOnline(getState().stream !== "down" && (browser?.navigator?.onLine ?? true));
  update();
  const off = useStore.subscribe((s, prev) => s.stream !== prev.stream && update());
  browser?.addEventListener("online", update);
  browser?.addEventListener("offline", update);
  return () => {
    off();
    browser?.removeEventListener("online", update);
    browser?.removeEventListener("offline", update);
  };
});

onReplaced(() => {
  if (!getState().slug) {
    queryClient.clear();
    return;
  }
  queryClient.removeQueries({ queryKey: ["w"], type: "inactive" });
  void queryClient.resetQueries({ queryKey: ["w"], type: "active" });
});
