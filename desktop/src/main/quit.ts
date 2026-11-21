// Quitting while a server's page holds on to itself: its `beforeunload`
// says an upload is under way (web/src/data/files.ts), and Electron, left
// to itself, cancels the window's close and with it the whole quit, without
// a word: Quit did nothing. So, while the app quits, the person is asked
// once ("A file is still uploading."): Quit lets every page go and the quit
// goes through; Don't quit keeps them, upload running, and the app stays as
// it was, a later Quit working (and asking) as the first did. Outside a
// quit, a page that holds on to itself is left alone, as before. A quit
// nothing holds is not touched at all.

/**
 * What the guard needs: the question, asked on the page that holds on
 * (`Page`, its web contents), whether the app runs in the background, and
 * how to undo the start of a quit.
 */
export interface QuitGuardParts<Page> {
  /** Asks the person, on `page`'s window, whether to quit all the same. */
  ask(page: Page): "quit" | "stay";
  /**
   * Whether the app runs in the background (started so, not opened since:
   * launch.ts, Quiet): nobody is there to answer, so nothing waits for an
   * answer and the quit goes through.
   */
  inBackground(): boolean;
  /** The person chose to stay: what the start of the quit stopped goes on (the windows close as windows again). */
  stayed(): void;
}

export class QuitGuard<Page> {
  private quitting = false;
  /** The answer for this quit, once asked: one question for the whole quit, however many pages hold on. */
  private answer: "quit" | "stay" | null = null;

  constructor(private parts: QuitGuardParts<Page>) {}

  /** The app has begun to quit (before-quit). */
  quitBegan() {
    this.quitting = true;
    this.answer = null;
  }

  /** A server's page (`page`) holds on to itself as it would be closed: whether it is let go. */
  letGo(page: Page): boolean {
    if (!this.quitting) return false;
    if (this.parts.inBackground()) return true;
    if (this.answer === null) {
      this.answer = this.parts.ask(page);
      if (this.answer === "stay") {
        this.quitting = false;
        this.parts.stayed();
      }
    }
    return this.answer === "quit";
  }
}
