// The desktop app's Connect, opened from a page: only where the app can
// connect agent tools on its computer (openConnect), never in a browser, an
// older app or on Windows.

import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@/ui/button";

/** Whether the app this page is in can connect agent tools on its computer. */
export const canConnectTools = () => !!window.quaditDesktop?.openConnect;

/** A button that opens the app's Connect for this page's server and workspace. */
export function ConnectToolsButton({ children, ...rest }: Omit<ButtonProps, "onClick"> & { children: ReactNode }) {
  return (
    <Button {...rest} onClick={() => window.quaditDesktop?.openConnect?.()}>
      {children}
    </Button>
  );
}
