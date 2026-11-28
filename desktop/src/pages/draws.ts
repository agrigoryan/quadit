// Connect agents is drawn from answers the app gives in turn (the tools as
// seen from a workspace, then where each stands), for the workspace the
// window under it shows, which can change while it waits. Only the last draw
// begun counts: one begun while the window showed A, whose answers come after
// it turned to B and B was drawn, is dropped, never drawn over B's (the
// delayed handshake, multi-workspace design §5). A draw learns which
// workspace it is for from its first answer; the window showing another one
// asks for a new draw.

/** One draw: whether it still counts, after each answer it waits for. */
export interface Draw {
  counts(): boolean;
  /** The answer it is drawn from is for `workspace` (a key; "" for none). */
  isFor(workspace: string): void;
}

export class Draws {
  private last = 0;
  /** The workspace the last draw begun is for, once it knows; null before. */
  private drawing: string | null = null;

  /** Begins a draw, which every one begun before it no longer counts against. */
  begin(): Draw {
    const mine = ++this.last;
    this.drawing = null;
    return {
      counts: () => mine === this.last,
      isFor: (workspace) => {
        if (mine === this.last) this.drawing = workspace;
      },
    };
  }

  /** Whether the window, now showing `workspace`, needs a new draw: the last one is for another. */
  stale(workspace: string): boolean {
    return this.drawing !== null && this.drawing !== workspace;
  }
}
