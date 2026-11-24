// The menu-bar panel's own words that are worked out (panel.ts): how long a
// run has been open, who a task waits on the person for, a workspace's
// heading. Apart from the page, for its tests.

/** How long a run has been open, as a person reads it: "for 3m", "for 2h 5m", "for 3d". */
export function openFor(since: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - since) / 60_000));
  if (minutes < 60) return `for ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `for ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `for ${Math.floor(hours / 24)}d`;
}

/** Who a task waits on the person for: its assignee, else nobody named. */
export function waitsWords(who: string): string {
  return who ? `${who} waits on you` : "Waits on you";
}

/** The heading of a workspace's block: its name, and its server's only when the app has more than one. */
export function headingOf(workspace: string, server: string, servers: number): string {
  return servers > 1 ? `${workspace} on ${server}` : workspace;
}
