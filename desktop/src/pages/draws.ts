// Connect agents is drawn from answers the app gives in turn (the tools as
// seen from a workspace, then where each stands), for the workspace the
// window under it shows, which can change while it waits. A draw counts only
// while it is the last one begun and its answers are for the workspace the
// window shows now: one begun while the window showed A, whose answers come
// after it turned to B, is dropped, never drawn over B's (the delayed
// handshake, multi-workspace design §5), whether its answer was still on its
// way when the window turned or came before. The window turning while a draw
// waits, or once one is drawn for another workspace, asks for a new draw.

/** One draw: whether it still counts, after each answer it waits for. */
export interface Draw {
  counts(): boolean;
  /** The answer it is drawn from is for `workspace` (a key; "" for none). */
  isFor(workspace: string): void;
}

export class Draws {
  private last = 0;
  /** The workspace the window shows, as last told (show); null before. */
  private shown: string | null = null;
  /** The workspace the last draw begun is for, once its answer says; null while it waits for it. */
  private drawing: string | null = null;

  /** Begins a draw, which every one begun before it no longer counts against. */
  begin(): Draw {
    const mine = ++this.last;
    this.drawing = null;
    return {
      counts: () => mine === this.last && (this.drawing === null || this.shown === null || this.drawing === this.shown),
      isFor: (workspace) => {
        if (mine === this.last) this.drawing = workspace;
      },
    };
  }

  /**
   * The window shows `workspace` now. Gives whether a new draw is to begin:
   * the last one is for another, or it waits for its answer and the window
   * turned meanwhile (that answer is for the workspace before).
   */
  show(workspace: string): boolean {
    const before = this.shown;
    this.shown = workspace;
    if (this.last === 0) return false;
    return this.drawing === null ? before !== workspace : this.drawing !== workspace;
  }
}
