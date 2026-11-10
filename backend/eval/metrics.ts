export interface ExpectedEvidenceGrade {
  id: string;
  relevance: number;
}

export interface RankedEvidenceResult {
  matchedEvidenceIds: string[];
}

export interface QuestionMetrics {
  recall: number;
  mrr: number;
  ndcg: number;
  relevanceGrades: number[];
}

export interface AggregateMetrics {
  recall: number;
  mrr: number;
  ndcg: number;
}

export function calculateQuestionMetrics(
  expected: ExpectedEvidenceGrade[],
  retrieved: RankedEvidenceResult[],
  topK: number,
): QuestionMetrics {
  const topResults = retrieved.slice(0, topK);
  const gradesById = new Map(expected.map((item) => [item.id, item.relevance]));
  const covered = new Set<string>();
  const relevanceGrades = topResults.map((result) => {
    const newlyCovered = result.matchedEvidenceIds.filter(
      (id) => gradesById.has(id) && !covered.has(id),
    );
    for (const id of newlyCovered) covered.add(id);
    return newlyCovered.reduce(
      (highest, id) => Math.max(highest, gradesById.get(id) ?? 0),
      0,
    );
  });

  const firstRelevantRank = topResults.findIndex((result) =>
    result.matchedEvidenceIds.some((id) => gradesById.has(id)),
  );
  const dcg = relevanceGrades.reduce(
    (total, relevance, index) =>
      total + (Math.pow(2, relevance) - 1) / Math.log2(index + 2),
    0,
  );
  const idealGrades = expected
    .map((item) => item.relevance)
    .sort((left, right) => right - left)
    .slice(0, topK);
  const idcg = idealGrades.reduce(
    (total, relevance, index) =>
      total + (Math.pow(2, relevance) - 1) / Math.log2(index + 2),
    0,
  );

  return {
    recall: expected.length === 0 ? 0 : covered.size / expected.length,
    mrr: firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
    ndcg: idcg === 0 ? 0 : dcg / idcg,
    relevanceGrades,
  };
}

export function calculateMacroMetrics(
  questions: QuestionMetrics[],
): AggregateMetrics {
  if (questions.length === 0) {
    return { recall: 0, mrr: 0, ndcg: 0 };
  }
  return {
    recall:
      questions.reduce((sum, metrics) => sum + metrics.recall, 0) /
      questions.length,
    mrr:
      questions.reduce((sum, metrics) => sum + metrics.mrr, 0) /
      questions.length,
    ndcg:
      questions.reduce((sum, metrics) => sum + metrics.ndcg, 0) /
      questions.length,
  };
}
