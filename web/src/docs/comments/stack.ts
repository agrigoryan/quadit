/** A card in a page's margin: how far down its words are, and how tall it is (pixels). */
export interface Card {
  id: string;
  want: number;
  height: number;
}

/**
 * Where each card in the margin goes (its top, by id), so that each is as
 * level with its words as it can be and none is over another. Cards are
 * taken by how far down their words are, those on the same line in the
 * order given. A card that would overlap the one above it is pushed down
 * below it, `gap` apart. The active card, when there is one, sits exactly
 * level with its words, as in Google Docs and Notion: the cards below it
 * are pushed down from it, those above are moved up out of its way (above
 * the first line, if need be).
 */
export function stackCards(cards: readonly Card[], active: string | null, gap: number): Map<string, number> {
  const sorted = [...cards].sort((a, b) => a.want - b.want);
  const tops = new Map<string, number>();
  const at = Math.max(
    sorted.findIndex((c) => c.id === active),
    0,
  );
  const fixed = sorted.find((c) => c.id === active);

  let floor = -Infinity;
  for (const card of sorted.slice(at)) {
    const top = card === fixed ? card.want : Math.max(card.want, floor);
    tops.set(card.id, top);
    floor = top + card.height + gap;
  }

  let ceiling = fixed ? fixed.want - gap : Infinity;
  for (const card of sorted.slice(0, at).reverse()) {
    const top = Math.min(card.want, ceiling - card.height);
    tops.set(card.id, top);
    ceiling = top - gap;
  }
  return tops;
}
