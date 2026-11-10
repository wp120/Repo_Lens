import "../src/config/loadEnv.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalize as normalizePosix } from "node:path/posix";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/database/prisma.js";
import { voyageRateLimits } from "../src/config/voyageRateLimits.js";
import {
  VOYAGE_DIMENSIONS,
  VOYAGE_MODEL,
} from "../src/services/voyageEmbedding.js";
import { retrieveRelevantChunks } from "../src/services/retrieval.js";
import type { RetrievedCodeChunk } from "../src/services/retrieval.js";
import {
  calculateMacroMetrics,
  calculateQuestionMetrics,
  type QuestionMetrics,
} from "./metrics.js";

interface DatasetEvidence {
  id: string;
  filePath: string;
  symbol?: string;
  relevance: number;
}

interface DatasetQuestion {
  id: string;
  question: string;
  answerable: boolean;
  expectedEvidence: DatasetEvidence[];
}

interface Dataset {
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

interface EvaluationResult {
  questionId: string;
  question: string;
  answerable: boolean;
  expectedEvidence: DatasetEvidence[];
  retrievedResults: Array<{
    chunkId: string;
    filePath: string;
    symbolName: string | null;
    symbolType: string | null;
    className: string | null;
    functionSignature: string | null;
    distance: number;
    matchedEvidenceIds: string[];
    relevanceGrade: number;
    contentSnippet: string;
  }>;
  metrics?: {
    recall: number;
    mrr: number;
    ndcg: number;
  };
  error?: string;
}

const datasetDirectory = fileURLToPath(new URL("./dataset/", import.meta.url));
const datasetFileNames = [
  "p-limit-main-retrieval-eval-v1.json",
  "p-limit-v1.json",
];
const resultsDirectory = fileURLToPath(new URL("./results/", import.meta.url));

function parseTopK(args: string[]): number {
  let value: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument.startsWith("--top-k=") || argument.startsWith("--topK=")) {
      value = argument.slice(argument.indexOf("=") + 1);
    } else if (argument === "--top-k" || argument === "--topK") {
      value = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown evaluation argument: ${argument}`);
    }
  }

  const topK = value === undefined ? 6 : Number(value);
  if (!Number.isSafeInteger(topK) || topK <= 0) {
    throw new Error("--top-k must be a positive integer.");
  }

  return topK;
}

function normalizePath(filePath: string): string {
  return normalizePosix(filePath.replace(/\\/g, "/"))
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDataset(value: unknown, sourcePath: string): Dataset {
  if (
    !isRecord(value) ||
    !isRecord(value.repository) ||
    !Array.isArray(value.questions)
  ) {
    throw new Error(`Invalid evaluation dataset structure: ${sourcePath}`);
  }

  const repository = value.repository;
  if (
    typeof value.datasetId !== "string" ||
    typeof value.version !== "string" ||
    typeof repository.owner !== "string" ||
    typeof repository.name !== "string" ||
    typeof repository.url !== "string" ||
    typeof repository.branch !== "string" ||
    !(typeof repository.commitSha === "string" || repository.commitSha === null)
  ) {
    throw new Error(`Invalid dataset metadata: ${sourcePath}`);
  }

  const questionIds = new Set<string>();
  for (const [questionIndex, question] of value.questions.entries()) {
    if (
      !isRecord(question) ||
      typeof question.id !== "string" ||
      typeof question.question !== "string" ||
      typeof question.answerable !== "boolean" ||
      !Array.isArray(question.expectedEvidence)
    ) {
      throw new Error(
        `Invalid question at index ${questionIndex} in ${sourcePath}`,
      );
    }

    if (questionIds.has(question.id)) {
      throw new Error(
        `Duplicate question ID "${question.id}" in ${sourcePath}`,
      );
    }
    questionIds.add(question.id);

    for (const [
      evidenceIndex,
      evidence,
    ] of question.expectedEvidence.entries()) {
      if (
        !isRecord(evidence) ||
        typeof evidence.id !== "string" ||
        typeof evidence.filePath !== "string" ||
        typeof evidence.relevance !== "number" ||
        !Number.isInteger(evidence.relevance) ||
        evidence.relevance < 1 ||
        evidence.relevance > 3 ||
        (evidence.symbol !== undefined && typeof evidence.symbol !== "string")
      ) {
        throw new Error(
          `Invalid expected evidence for question ${question.id} at index ${evidenceIndex}`,
        );
      }
    }

    if (question.answerable && question.expectedEvidence.length === 0) {
      throw new Error(
        `Answerable question ${question.id} has no expected evidence.`,
      );
    }
  }

  if (
    !value.questions.some(
      (question) => isRecord(question) && question.answerable === true,
    )
  ) {
    throw new Error(
      "Dataset contains no answerable questions; cannot calculate retrieval metrics.",
    );
  }

  return value as unknown as Dataset;
}

async function loadDataset(): Promise<Dataset> {
  let contents: string | undefined;
  let loadedPath: string | undefined;

  for (const fileName of datasetFileNames) {
    const candidatePath = resolve(datasetDirectory, fileName);
    try {
      contents = await readFile(candidatePath, "utf8");
      loadedPath = candidatePath;
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (contents === undefined || loadedPath === undefined) {
    throw new Error(
      `Dataset not found. Expected one of: ${datasetFileNames
        .map((fileName) => resolve(datasetDirectory, fileName))
        .join(", ")}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Dataset is not valid JSON (${loadedPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const dataset = validateDataset(parsed, loadedPath);
  console.log(`Loaded dataset: ${loadedPath}`);
  return dataset;
}

async function resolveBranchIndex(dataset: Dataset) {
  const repository = await prisma.repository.findFirst({
    where: {
      owner: dataset.repository.owner,
      name: dataset.repository.name,
    },
    select: {
      id: true,
      owner: true,
      name: true,
      htmlUrl: true,
      branchIndexes: {
        where: { branchName: dataset.repository.branch },
        select: { id: true, branchName: true, status: true },
      },
    },
  });

  if (!repository) {
    throw new Error(
      `Repository ${dataset.repository.owner}/${dataset.repository.name} is not present in the RepoLens database.`,
    );
  }

  const branch = repository.branchIndexes[0];
  if (!branch) {
    throw new Error(
      `Branch index ${dataset.repository.owner}/${dataset.repository.name}@${dataset.repository.branch} is missing.`,
    );
  }

  if (branch.status !== "ready") {
    throw new Error(
      `Branch index ${dataset.repository.owner}/${dataset.repository.name}@${dataset.repository.branch} is ${branch.status}, not ready. Run ingestion separately and retry evaluation.`,
    );
  }

  console.log(`Resolved branch index: ${branch.id}`);
  return { repository, branch };
}

function hasExactIdentifier(value: string, identifier: string): boolean {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `(^|[^A-Za-z0-9_$])${escapedIdentifier}($|[^A-Za-z0-9_$])`,
  );
  return expression.test(value);
}

function matchesSymbol(
  expectedSymbol: string | undefined,
  chunk: Pick<
    RetrievedCodeChunk,
    "symbolName" | "className" | "functionSignature" | "content"
  >,
): boolean {
  if (!expectedSymbol) {
    return true;
  }

  const metadata = [chunk.symbolName, chunk.className, chunk.functionSignature]
    .filter((value): value is string => value !== null)
    .join(" ");

  // Metadata is preferred, but chunk content is also checked when metadata exists
  // and does not contain the expected symbol.
  return (
    hasExactIdentifier(metadata, expectedSymbol) ||
    hasExactIdentifier(chunk.content, expectedSymbol)
  );
}

function evidenceMatchesChunk(
  evidence: DatasetEvidence,
  chunk: RetrievedCodeChunk,
): boolean {
  return (
    normalizePath(evidence.filePath) === normalizePath(chunk.filePath) &&
    matchesSymbol(evidence.symbol, chunk)
  );
}

async function collectPreflightWarnings(
  branchIndexId: string,
  questions: DatasetQuestion[],
  datasetCommitSha: string | null,
): Promise<{
  warnings: Array<Record<string, unknown>>;
  indexedCommitSha: string | null;
}> {
  const expectedEvidence = questions.flatMap(
    (question) => question.expectedEvidence,
  );
  const expectedPaths = [
    ...new Set(
      expectedEvidence.map((evidence) => normalizePath(evidence.filePath)),
    ),
  ];

  const corpusFilePaths = await prisma.codeChunk.findMany({
    where: { branchIndexId },
    select: { filePath: true },
    distinct: ["filePath"],
  });

  const matchingStoredPaths = corpusFilePaths
    .map((chunk) => chunk.filePath)
    .filter((filePath) => expectedPaths.includes(normalizePath(filePath)));

  const corpusChunks =
    matchingStoredPaths.length === 0
      ? []
      : await prisma.codeChunk.findMany({
          where: { branchIndexId, filePath: { in: matchingStoredPaths } },
          select: {
            filePath: true,
            content: true,
            symbolName: true,
            symbolType: true,
            className: true,
            functionSignature: true,
          },
        });

  const pathSet = new Set(
    corpusChunks.map((chunk) => normalizePath(chunk.filePath)),
  );
  const warnings: Array<Record<string, unknown>> = [];

  for (const filePath of expectedPaths) {
    if (!pathSet.has(filePath)) {
      warnings.push({ type: "missing_file_path", filePath });
    }
  }

  const symbolEvidence = new Map<
    string,
    { filePath: string; symbol: string; evidenceIds: string[] }
  >();

  for (const evidence of expectedEvidence) {
    if (!evidence.symbol) {
      continue;
    }

    const key = `${normalizePath(evidence.filePath)}\u0000${evidence.symbol}`;
    const entry = symbolEvidence.get(key) ?? {
      filePath: evidence.filePath,
      symbol: evidence.symbol,
      evidenceIds: [],
    };
    entry.evidenceIds.push(evidence.id);
    symbolEvidence.set(key, entry);
  }

  for (const evidence of symbolEvidence.values()) {
    const found = corpusChunks.some(
      (chunk) =>
        normalizePath(chunk.filePath) === normalizePath(evidence.filePath) &&
        matchesSymbol(evidence.symbol, chunk),
    );

    if (!found) {
      warnings.push({
        type: "missing_symbol",
        filePath: evidence.filePath,
        symbol: evidence.symbol,
        evidenceIds: evidence.evidenceIds,
      });
    }
  }

  const indexedCommits = await prisma.codeChunk.findMany({
    where: { branchIndexId },
    select: { commitSha: true },
    distinct: ["commitSha"],
    take: 2,
  });

  const indexedCommitSha =
    indexedCommits.length === 1 ? indexedCommits[0].commitSha : null;

  if (!indexedCommitSha) {
    warnings.push({
      type: "indexed_commit_sha_unavailable",
      message:
        indexedCommits.length > 1
          ? "Chunks in this branch index contain multiple commit SHAs."
          : "No indexed commit SHA is available in code_chunks.",
    });
  }

  if (!datasetCommitSha) {
    warnings.push({
      type: "dataset_commit_sha_missing",
      message:
        "The dataset does not pin a commit SHA; main is mutable, so scores may not be reproducible across ingestions.",
    });
  }

  return { warnings, indexedCommitSha };
}

function toReportResult(
  chunk: RetrievedCodeChunk,
  expected: DatasetEvidence[],
): EvaluationResult["retrievedResults"][number] {
  const matchedEvidenceIds = expected
    .filter((evidence) => evidenceMatchesChunk(evidence, chunk))
    .map((evidence) => evidence.id);

  return {
    chunkId: chunk.id,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    className: chunk.className,
    functionSignature: chunk.functionSignature,
    distance: chunk.distance,
    matchedEvidenceIds,
    relevanceGrade: 0,
    contentSnippet: chunk.content.slice(0, 250),
  };
}

async function main(): Promise<void> {
  const topK = parseTopK(process.argv.slice(2));
  const dataset = await loadDataset();
  const { repository, branch } = await resolveBranchIndex(dataset);
  const { warnings, indexedCommitSha } = await collectPreflightWarnings(
    branch.id,
    dataset.questions,
    dataset.repository.commitSha,
  );

  const results: EvaluationResult[] = [];
  const answerableMetrics: QuestionMetrics[] = [];
  let failed = false;

  for (const question of dataset.questions) {
    const expectedEvidence = question.expectedEvidence;

    try {
      const retrieved = await retrieveRelevantChunks(
        branch.id,
        question.question,
        topK,
      );

      const retrievedResults = retrieved.map((chunk) =>
        toReportResult(chunk, expectedEvidence),
      );

      let questionMetrics:
        ReturnType<typeof calculateQuestionMetrics> | undefined;

      if (question.answerable) {
        questionMetrics = calculateQuestionMetrics(
          expectedEvidence.map((evidence) => ({
            id: evidence.id,
            relevance: evidence.relevance,
          })),
          retrievedResults,
          topK,
        );

        retrievedResults.forEach((result, index) => {
          result.relevanceGrade = questionMetrics?.relevanceGrades[index] ?? 0;
        });
        answerableMetrics.push(questionMetrics);
      }

      results.push({
        questionId: question.id,
        question: question.question,
        answerable: question.answerable,
        expectedEvidence,
        retrievedResults,
        ...(questionMetrics
          ? {
              metrics: {
                recall: questionMetrics.recall,
                mrr: questionMetrics.mrr,
                ndcg: questionMetrics.ndcg,
              },
            }
          : {}),
      });
    } catch (error) {
      failed = true;
      results.push({
        questionId: question.id,
        question: question.question,
        answerable: question.answerable,
        expectedEvidence,
        retrievedResults: [],
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  if (!failed && answerableMetrics.length === 0) {
    throw new Error(
      "No answerable questions were evaluated; aggregate metrics cannot be calculated.",
    );
  }

  const aggregate = failed ? null : calculateMacroMetrics(answerableMetrics);
  const timestamp = new Date().toISOString();
  const report = {
    metadata: {
      evaluationTimestamp: timestamp,
      status: failed ? "failed" : "completed",
      datasetId: dataset.datasetId,
      datasetVersion: dataset.version,
      repository: {
        owner: repository.owner,
        name: repository.name,
        url: dataset.repository.url,
        branch: branch.branchName,
        datasetCommitSha: dataset.repository.commitSha,
        indexedCommitSha,
      },
      branchIndexId: branch.id,
      retrievalMethod: "vector",
      topK,
      embedding: {
        provider: "Voyage AI",
        model: VOYAGE_MODEL,
        dimensions: VOYAGE_DIMENSIONS,
        maxRetries: voyageRateLimits.maxRetries,
        maxBackoffMs: voyageRateLimits.maxBackoffMs,
        maxInputsPerRequest: voyageRateLimits.maxInputsPerRequest,
        maxTokensPerRequest: voyageRateLimits.maxTokensPerRequest,
        minSpacingMs: voyageRateLimits.minSpacingMs,
        maxWaitMs: voyageRateLimits.maxWaitMs,
      },
      evaluatedQuestionCount: results.length,
    },
    aggregateMetrics: {
      answerableQuestionCount: dataset.questions.filter(
        (question) => question.answerable,
      ).length,
      unanswerableQuestionCount: dataset.questions.filter(
        (question) => !question.answerable,
      ).length,
      [`Recall@${topK}`]: aggregate?.recall ?? null,
      [`MRR@${topK}`]: aggregate?.mrr ?? null,
      [`nDCG@${topK}`]: aggregate?.ndcg ?? null,
    },
    questions: results,
    preflightWarnings: warnings,
  };

  await mkdir(resultsDirectory, { recursive: true });
  const outputPath = resolve(
    resultsDirectory,
    `${timestamp.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Dataset: ${dataset.datasetId} v${dataset.version}`);
  console.log(
    `Repository: ${repository.owner}/${repository.name}@${branch.branchName}`,
  );
  console.log(
    `Questions evaluated: ${results.length}/${dataset.questions.length}`,
  );

  if (aggregate) {
    console.log(
      `Recall@${topK}: ${aggregate.recall.toFixed(4)} | MRR@${topK}: ${aggregate.mrr.toFixed(4)} | nDCG@${topK}: ${aggregate.ndcg.toFixed(4)}`,
    );
  } else {
    console.error("Evaluation failed; aggregate metrics were not calculated.");
  }

  console.log(`Report: ${outputPath}`);
  for (const warning of warnings) {
    console.warn(`Preflight warning: ${JSON.stringify(warning)}`);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Evaluation failed.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
