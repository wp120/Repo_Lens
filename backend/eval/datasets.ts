export interface DatasetEvidence {
  id: string;
  filePath: string;
  symbol?: string;
  relevance: number;
}

export interface DatasetQuestion {
  id: string;
  question: string;
  answerable: boolean;
  expectedEvidence: DatasetEvidence[];
}

export interface Dataset {
  datasetId: string;
  version: string;
  repository: {
    owner: string;
    name: string;
    url: string;
    branch: string;
    commitSha: string | null;
  };
  questions: DatasetQuestion[];
}

export function isDatasetActive(value: unknown, sourceName: string): boolean {
  if (!isRecord(value) || !Object.hasOwn(value, "isActive")) {
    return true;
  }
  if (typeof value.isActive !== "boolean") {
    throw new Error(
      `Invalid isActive value in ${sourceName}; expected a boolean.`,
    );
  }
  return value.isActive;
}

export function normalizeDataset(value: unknown, sourceName: string): Dataset {
  if (!isRecord(value) || !isRecord(value.repository)) {
    throw new Error(`Invalid dataset structure in ${sourceName}.`);
  }

  const { repository } = value;
  if (
    !nonEmptyString(value.datasetId) ||
    !nonEmptyString(value.version) ||
    !nonEmptyString(repository.owner) ||
    !nonEmptyString(repository.name) ||
    !nonEmptyString(repository.url) ||
    !nonEmptyString(repository.branch) ||
    !(
      repository.commitSha === undefined ||
      repository.commitSha === null ||
      typeof repository.commitSha === "string"
    )
  ) {
    throw new Error(`Invalid dataset or repository metadata in ${sourceName}.`);
  }
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw new Error(`Dataset has no questions in ${sourceName}.`);
  }

  const questionIds = new Set<string>();
  const questions = value.questions.map((rawQuestion, questionIndex) => {
    if (isRecord(rawQuestion)) {
      assertOnlyKeys(
        rawQuestion,
        ["id", "question", "answerable", "expectedEvidence"],
        `${sourceName} question at index ${questionIndex}`,
      );
    }
    if (
      !isRecord(rawQuestion) ||
      !nonEmptyString(rawQuestion.id) ||
      typeof rawQuestion.question !== "string" ||
      !Array.isArray(rawQuestion.expectedEvidence)
    ) {
      throw new Error(
        `Invalid question at index ${questionIndex} in ${sourceName}.`,
      );
    }

    if (questionIds.has(rawQuestion.id)) {
      throw new Error(
        `Duplicate question ID "${rawQuestion.id}" in ${sourceName}.`,
      );
    }
    questionIds.add(rawQuestion.id);

    if (typeof rawQuestion.answerable !== "boolean") {
      throw new Error(
        `Missing or invalid answerable value in ${sourceName} question ${rawQuestion.id}.`,
      );
    }
    const answerable = rawQuestion.answerable;
    const evidenceIds = new Set<string>();
    const expectedEvidence = rawQuestion.expectedEvidence.map(
      (rawEvidence, evidenceIndex): DatasetEvidence => {
        if (isRecord(rawEvidence)) {
          assertOnlyKeys(
            rawEvidence,
            ["id", "filePath", "symbol", "relevance"],
            `${sourceName} question ${rawQuestion.id} evidence ${evidenceIndex + 1}`,
          );
        }
        if (!isRecord(rawEvidence) || !nonEmptyString(rawEvidence.filePath)) {
          throw new Error(
            `Invalid evidence at index ${evidenceIndex} for question ${rawQuestion.id} in ${sourceName}.`,
          );
        }

        if (
          rawEvidence.symbol !== undefined &&
          !nonEmptyString(rawEvidence.symbol)
        ) {
          throw new Error(
            `Invalid symbol in ${sourceName} question ${rawQuestion.id} evidence ${evidenceIndex + 1}.`,
          );
        }
        const symbol = rawEvidence.symbol;
        const id = rawEvidence.id;
        if (!nonEmptyString(id)) {
          throw new Error(
            `Missing or invalid evidence ID at index ${evidenceIndex} for question ${rawQuestion.id} in ${sourceName}.`,
          );
        }
        if (evidenceIds.has(id)) {
          throw new Error(
            `Duplicate evidence ID "${id}" for question ${rawQuestion.id} in ${sourceName}.`,
          );
        }
        evidenceIds.add(id);

        if (
          typeof rawEvidence.relevance !== "number" ||
          !Number.isInteger(rawEvidence.relevance) ||
          rawEvidence.relevance < 1 ||
          rawEvidence.relevance > 3
        ) {
          throw new Error(
            `Invalid relevance grade for question ${rawQuestion.id} evidence ${id} in ${sourceName}; expected 1, 2, or 3.`,
          );
        }

        return {
          id,
          filePath: rawEvidence.filePath,
          ...(symbol === undefined ? {} : { symbol }),
          relevance: rawEvidence.relevance,
        };
      },
    );

    if (answerable && expectedEvidence.length === 0) {
      throw new Error(
        `Answerable question ${rawQuestion.id} has no expected evidence in ${sourceName}.`,
      );
    }

    return {
      id: rawQuestion.id,
      question: rawQuestion.question,
      answerable,
      expectedEvidence,
    };
  });

  if (!questions.some((question) => question.answerable)) {
    throw new Error(
      `Dataset has no answerable questions in ${sourceName}; metrics cannot be calculated.`,
    );
  }

  return {
    datasetId: value.datasetId,
    version: value.version,
    repository: {
      owner: repository.owner,
      name: repository.name,
      url: repository.url,
      branch: repository.branch,
      commitSha: repository.commitSha ?? null,
    },
    questions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: string[],
  description: string,
): void {
  const unexpected = Object.keys(record).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpected) {
    throw new Error(`Unexpected field "${unexpected}" in ${description}.`);
  }
}
