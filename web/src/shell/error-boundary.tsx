import { Component, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/**
 * Keeps a fault in one page from blanking the whole app: the frame stays,
 * and the page says what happened and offers to try again.
 */
export class PageBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    // Going to another page clears the fault.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
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
