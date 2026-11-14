import type { ComponentProps } from "react";
import { Tabs as RTabs } from "radix-ui";
import { cx } from "@/lib/cx";

export const Tabs = RTabs.Root;
export const TabsContent = RTabs.Content;

export function TabsList({ className, ...rest }: ComponentProps<typeof RTabs.List>) {
  return <RTabs.List className={cx("flex items-center gap-0.5 border-b border-line", className)} {...rest} />;
}

export function TabsTrigger({ className, ...rest }: ComponentProps<typeof RTabs.Trigger>) {
  return (
    <RTabs.Trigger
      className={cx(
        "-mb-px h-8 border-b-2 border-transparent px-2.5 text-sm font-medium text-ink-2 transition-colors hover:text-ink",
        "data-[state=active]:border-accent data-[state=active]:text-ink",
        className,
      )}
      {...rest}
    />
  );
}
