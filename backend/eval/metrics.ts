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

export interface RepositoryMetricInput {
  status: "completed" | "failed";
  questions: Array<{
    answerable: boolean;
    metrics?: QuestionMetrics;
  }>;
}

export interface MultiRepositoryMetrics {
  status: "completed" | "partial" | "failed";
  completedRepositoryCount: number;
  failedRepositoryCount: number;
  questionWeighted: AggregateMetrics | null;
  repositoryWeighted: AggregateMetrics | null;
}

export interface OfficialMultiRepositoryMetrics {
  questionWeighted: AggregateMetrics;
  repositoryWeighted: AggregateMetrics;
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
  questions: Array<Pick<QuestionMetrics, "recall" | "mrr" | "ndcg">>,
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

export function calculateMultiRepositoryMetrics(
  repositories: RepositoryMetricInput[],
): MultiRepositoryMetrics {
  const completed = repositories.filter(
    (repository) => repository.status === "completed",
  );
  const answerableMetrics = completed.flatMap((repository) =>
    repository.questions.flatMap((question) =>
      question.answerable && question.metrics ? [question.metrics] : [],
    ),
  );
  const repositoryMetrics = completed.map((repository) =>
    calculateMacroMetrics(
      repository.questions.flatMap((question) =>
        question.answerable && question.metrics ? [question.metrics] : [],
      ),
    ),
  );
  const completedRepositoryCount = completed.length;
  const failedRepositoryCount = repositories.length - completedRepositoryCount;

  return {
    status:
      repositories.length > 0 && failedRepositoryCount === 0
        ? "completed"
        : completedRepositoryCount === 0
          ? "failed"
          : "partial",
    completedRepositoryCount,
    failedRepositoryCount,
    questionWeighted:
      answerableMetrics.length > 0
        ? calculateMacroMetrics(answerableMetrics)
        : null,
    repositoryWeighted:
      repositoryMetrics.length > 0
        ? calculateMacroMetrics(repositoryMetrics)
        : null,
  };
}

export function getOfficialMultiRepositoryMetrics(
  metrics: MultiRepositoryMetrics,
  configuredRepositoryCount: number,
): OfficialMultiRepositoryMetrics | null {
  if (
    metrics.status !== "completed" ||
    metrics.completedRepositoryCount !== configuredRepositoryCount ||
    !metrics.questionWeighted ||
    !metrics.repositoryWeighted
  ) {
    return null;
  }
  return {
    questionWeighted: metrics.questionWeighted,
    repositoryWeighted: metrics.repositoryWeighted,
  };
}
