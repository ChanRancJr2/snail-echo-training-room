export type ReviewPoint = { id: string; original: string };

export function summarizePointReview<T extends ReviewPoint>(points: readonly T[], accuratePointIds?: readonly string[] | null) {
  if (accuratePointIds == null) return null;
  const selected = new Set(accuratePointIds);
  const unselected = points.filter(point => !selected.has(point.id));
  return { total: points.length, accurate: points.length - unselected.length, unselected };
}

export function correspondingRetell(quote: string | null, transcript?: string | null) {
  const excerpt = quote?.trim();
  if (!excerpt) return '未找到对应句子';
  const sentences = transcript?.match(/[^。！？!?\n]+[。！？!?]?/g) ?? [];
  const matches = sentences.map(sentence => sentence.trim()).filter(sentence => sentence.includes(excerpt));
  return matches.length === 1 ? matches[0]! : excerpt;
}
