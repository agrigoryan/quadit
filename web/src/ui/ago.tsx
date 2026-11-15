import { useMinute } from "@/hooks/tick";
import { ago } from "@/lib/time";

/** A relative time ("just now", "5m", "3h") that keeps itself current. */
export function Ago({ ms }: { ms: number }) {
  useMinute();
  return <>{ago(ms)}</>;
}
