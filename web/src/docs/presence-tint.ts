const TINTS = ["#5b6ee1", "#0f8a8a", "#b0578d", "#7a6ad8", "#2f8f5b", "#b7791f", "#4a7fb5", "#a85b4a"];

/** The same calm tint a person's avatar has (ui/avatar.tsx): their colour wherever they show up in a page. */
export function tintOf(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length] as string;
}
