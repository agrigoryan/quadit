// The boundaries that keep a fault in one part of the app from blanking the
// rest. Each is reset by its resetKey: a fault belongs to the page or the
// part it happened in, and going to another clears it.

import { Component, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/**
 * Keeps a fault in one page from blanking the whole app: the frame stays,
 * and the page says what happened and offers to try again.
 */
interface Props {
  /** Changes when the person goes elsewhere: the fault is then forgotten. */
  resetKey: string;
  children: ReactNode;
}

export class PageBoundary extends Component<Props, { error: Error | null; resetKey: string }> {
  state = { error: null as Error | null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  /** Going to another page clears the fault. */
  static getDerivedStateFromProps(props: Props, state: { resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        title={t("common.pageFailed")}
        hint={this.state.error.message}
        action={<Button onClick={() => window.location.reload()}>{t("common.reload")}</Button>}
      />
    );
  }
}

/**
 * For the parts drawn over the page (the task panel, the palette, a
 * dialog), which are fetched when first opened: if one cannot be fetched or
 * faults, the page under it stays. A toast says so and offers to reload,
 * and the part is left out until it is asked for again.
 */
export class PartBoundary extends Component<Props, { failed: boolean; resetKey: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    toast.error(t("common.partFailed"), { label: t("common.reload"), run: () => window.location.reload() });
  }

  /** Asked for again (another part, or the same one opened anew), it is tried again. */
  static getDerivedStateFromProps(props: Props, state: { resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
