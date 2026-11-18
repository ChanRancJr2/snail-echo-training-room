export interface PracticeMaterial {
  id: string;
  topic: string;
  title: string;
  source: string[];
  keywords: string[];
  checks: { sourceIndex: number; keywords: string[]; tag: string; question: string }[];
  advice: string;
}

export interface PracticeComparisonItem {
  id: string;
  original: string;
  retell: string;
  tag: string;
  question: string;
  complete: boolean;
  accurate: boolean;
}

const normalize = (value: string) => value.normalize('NFKC').replace(/[\p{P}\s]/gu, '').toLowerCase();

export function comparePractice(material: PracticeMaterial, input: string) {
  const lines = (input.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? []).map(line => line.trim()).filter(Boolean);
  const candidates = lines.map(line => ({ line, normalized: normalize(line) }));
  const rows = material.checks.map((check): PracticeComparisonItem => {
    const keywords = check.keywords.map(normalize);
    let match = '';
    let bestScore = 0;
    for (const { line, normalized } of candidates) {
      const score = keywords.filter(keyword => normalized.includes(keyword)).length;
      if (score > bestScore) {
        bestScore = score;
        match = line;
      }
    }
    const complete = bestScore > 0;
    const accurate = complete && bestScore === keywords.length;
    return {
      id: `source-${check.sourceIndex}`, original: material.source[check.sourceIndex] ?? '',
      retell: match, tag: accurate ? '要点吻合' : check.tag, question: accurate ? '' : check.question,
      complete, accurate,
    };
  });
  return {
    rows, issues: rows.filter(row => !row.complete || !row.accurate), total: rows.length,
    complete: rows.filter(row => row.complete).length, accurate: rows.filter(row => row.accurate).length,
  };
}
