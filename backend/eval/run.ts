import "../src/config/loadEnv.js";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  calculateMultiRepositoryMetrics,
  calculateQuestionMetrics,
  getOfficialMultiRepositoryMetrics,
  type AggregateMetrics,
  type QuestionMetrics,
} from "./metrics.js";
import {
  normalizeDataset,
  type Dataset,
  type DatasetEvidence,
  type DatasetQuestion,
} from "./datasets.js";

const datasetDirectory = fileURLToPath(new URL("./dataset/", import.meta.url));
const resultsDirectory = fileURLToPath(new URL("./results/", import.meta.url));

interface LoadedDataset {
  fileName: string;
  dataset?: Dataset;
  failureReason?: string;
}

interface QuestionResult {
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

interface RepositoryResult {
  status: "completed" | "failed";
  questionMetrics: Array<{
    answerable: boolean;
    metrics?: QuestionMetrics;
  }>;
  datasetFile: string;
  datasetId?: string;
  datasetVersion?: string;
  repository?: {
    owner: string;
    name: string;
    url: string;
    branch: string;
    datasetCommitSha: string | null;
    indexedCommitSha: string | null;
  };
  branchIndexId: string | null;
  answerableQuestionCount: number;
  unanswerableQuestionCount: number;
  aggregateMetrics: Record<string, number> | null;
  questions: QuestionResult[];
  preflightWarnings: Array<Record<string, unknown>>;
  failureReason?: string;
}

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

async function loadActiveDatasets(): Promise<LoadedDataset[]> {
  const entries = await readdir(datasetDirectory, { withFileTypes: true });
  const fileNames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith("-retrieval-eval-v1.json"),
    )
    .map((entry) => entry.name)
    .sort();
  if (fileNames.length === 0) {
    throw new Error(
      `No retrieval datasets ending in "-retrieval-eval-v1.json" were found directly in ${datasetDirectory}.`,
    );
  }
  console.log("Multi-repository retrieval evaluation");
  console.log(`Discovered datasets (${fileNames.length}): ${fileNames.join(", ")}`);

  const loaded: LoadedDataset[] = [];
  for (const fileName of fileNames) {
    const path = resolve(datasetDirectory, fileName);
    try {
      const contents = await readFile(path, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch (error) {
        throw new Error(
          `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      loaded.push({
        fileName,
        dataset: normalizeDataset(parsed, fileName),
      });
    } catch (error) {
      const message =
        isRecord(error) && error.code === "ENOENT"
          ? `Configured dataset file is missing: ${path}`
          : error instanceof Error
            ? error.message
            : String(error);
      loaded.push({ fileName, failureReason: message });
    }
  }
  return loaded;
}

async function resolveBranchIndex(dataset: Dataset) {
  const repository = await prisma.repository.findFirst({
    where: {
      owner: dataset.repository.owner,
      name: dataset.repository.name,
    },
    select: {
      owner: true,
      name: true,
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
  return { branch };
}

function hasExactIdentifier(value: string, identifier: string): boolean {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^A-Za-z0-9_$])${escapedIdentifier}($|[^A-Za-z0-9_$])`,
  ).test(value);
}

function matchesSymbol(
  expectedSymbol: string | undefined,
  chunk: Pick<
    RetrievedCodeChunk,
    "symbolName" | "className" | "functionSignature" | "content"
  >,
): boolean {
  if (!expectedSymbol) return true;
  const metadata = [chunk.symbolName, chunk.className, chunk.functionSignature]
    .filter((value): value is string => value !== null)
    .join(" ");
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
    if (!evidence.symbol) continue;
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
        "The dataset does not pin a commit SHA; its branch is mutable, so scores may not be reproducible across ingestions.",
    });
  }
  return { warnings, indexedCommitSha };
}

function toReportResult(
  chunk: RetrievedCodeChunk,
  expected: DatasetEvidence[],
): QuestionResult["retrievedResults"][number] {
  return {
    chunkId: chunk.id,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    className: chunk.className,
    functionSignature: chunk.functionSignature,
    distance: chunk.distance,
    matchedEvidenceIds: expected
      .filter((evidence) => evidenceMatchesChunk(evidence, chunk))
      .map((evidence) => evidence.id),
    relevanceGrade: 0,
    contentSnippet: chunk.content.slice(0, 250),
  };
}

function emptyRepositoryResult(loaded: LoadedDataset): RepositoryResult {
  const dataset = loaded.dataset;
  const result: RepositoryResult = {
    datasetFile: loaded.fileName,
    ...(dataset
      ? {
          datasetId: dataset.datasetId,
          datasetVersion: dataset.version,
          repository: {
            owner: dataset.repository.owner,
            name: dataset.repository.name,
            url: dataset.repository.url,
            branch: dataset.repository.branch,
            datasetCommitSha: dataset.repository.commitSha,
            indexedCommitSha: null,
          },
        }
      : {}),
    status: "failed",
    questionMetrics: [],
    questions: [],
    branchIndexId: null,
    answerableQuestionCount:
      dataset?.questions.filter((question) => question.answerable).length ?? 0,
    unanswerableQuestionCount:
      dataset?.questions.filter((question) => !question.answerable).length ??
      0,
    aggregateMetrics: null,
    preflightWarnings: [],
  };
  if (loaded.failureReason) {
    result.failureReason = loaded.failureReason;
  } else if (dataset) {
    result.failureReason = "Repository evaluation did not complete.";
  }
  return result;
}

async function evaluateDataset(
  loaded: LoadedDataset,
  topK: number,
): Promise<RepositoryResult> {
  const result = emptyRepositoryResult(loaded);
  if (!loaded.dataset) return result;
  const dataset = loaded.dataset;
  try {
    const { branch } = await resolveBranchIndex(dataset);
    result.branchIndexId = branch.id;
    const { warnings, indexedCommitSha } = await collectPreflightWarnings(
      branch.id,
      dataset.questions,
      dataset.repository.commitSha,
    );
    result.preflightWarnings = warnings;
    if (result.repository) result.repository.indexedCommitSha = indexedCommitSha;

    for (const question of dataset.questions) {
      try {
        const retrieved = await retrieveRelevantChunks(
          branch.id,
          question.question,
          topK,
        );
        const retrievedResults = retrieved.map((chunk) =>
          toReportResult(chunk, question.expectedEvidence),
        );
        let metrics: QuestionMetrics | undefined;
        if (question.answerable) {
          metrics = calculateQuestionMetrics(
            question.expectedEvidence.map(({ id, relevance }) => ({
              id,
              relevance,
            })),
            retrievedResults,
            topK,
          );
          retrievedResults.forEach((item, index) => {
            item.relevanceGrade = metrics?.relevanceGrades[index] ?? 0;
          });
          result.questionMetrics.push({ answerable: true, metrics });
        }
        result.questions.push({
          questionId: question.id,
          question: question.question,
          answerable: question.answerable,
          expectedEvidence: question.expectedEvidence,
          retrievedResults,
          ...(metrics
            ? {
                metrics: {
                  recall: metrics.recall,
                  mrr: metrics.mrr,
                  ndcg: metrics.ndcg,
                },
              }
            : {}),
        });
      } catch (error) {
        result.questions.push({
          questionId: question.id,
          question: question.question,
          answerable: question.answerable,
          expectedEvidence: question.expectedEvidence,
          retrievedResults: [],
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Retrieval failed for question ${question.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }

    result.status = "completed";
    const repositoryMetrics = calculateMacroMetrics(
      result.questionMetrics.flatMap((question) =>
        question.metrics ? [question.metrics] : [],
      ),
    );
    result.aggregateMetrics = {
      [`Recall@${topK}`]: repositoryMetrics.recall,
      [`MRR@${topK}`]: repositoryMetrics.mrr,
      [`nDCG@${topK}`]: repositoryMetrics.ndcg,
    };
  } catch (error) {
    result.status = "failed";
    result.failureReason =
      error instanceof Error ? error.message : String(error);
    result.aggregateMetrics = null;
    result.questions = result.questions.map((question) => ({
      ...question,
      metrics: undefined,
    }));
    result.questions.forEach((question) => {
      delete question.metrics;
    });
    result.questionMetrics = [];
  }
  return result;
}

function metricReport(
  metrics: AggregateMetrics | null,
  topK: number,
): Record<string, number> | null {
  return metrics
    ? {
        [`Recall@${topK}`]: metrics.recall,
        [`MRR@${topK}`]: metrics.mrr,
        [`nDCG@${topK}`]: metrics.ndcg,
      }
    : null;
}

function countQuestions(datasets: LoadedDataset[], answerable: boolean): number {
  return datasets.reduce(
    (total, loaded) =>
      total +
      (loaded.dataset?.questions.filter(
        (question) => question.answerable === answerable,
      ).length ?? 0),
    0,
  );
}

async function main(): Promise<void> {
  const topK = parseTopK(process.argv.slice(2));
  const loadedDatasets = await loadActiveDatasets();
  const repositoryResults: RepositoryResult[] = [];

  for (const loaded of loadedDatasets) {
    repositoryResults.push(await evaluateDataset(loaded, topK));
  }

  const multiMetrics = calculateMultiRepositoryMetrics(
    repositoryResults.map((repository) => ({
      status: repository.status,
      questions: repository.questionMetrics,
    })),
  );
  const officialMetrics = getOfficialMultiRepositoryMetrics(
    multiMetrics,
    loadedDatasets.length,
  );
  const overallAggregateMetrics = officialMetrics
    ? {
        questionWeighted: metricReport(officialMetrics.questionWeighted, topK),
        repositoryWeighted: metricReport(
          officialMetrics.repositoryWeighted,
          topK,
        ),
        answerableQuestionCount: countQuestions(loadedDatasets, true),
        unanswerableQuestionCount: countQuestions(loadedDatasets, false),
        repositoryCount: loadedDatasets.length,
      }
    : null;
  const partialDiagnostics =
    !officialMetrics && multiMetrics.completedRepositoryCount > 0
      ? {
          completedRepositoryCount: multiMetrics.completedRepositoryCount,
          questionWeighted: metricReport(multiMetrics.questionWeighted, topK),
          repositoryWeighted: metricReport(multiMetrics.repositoryWeighted, topK),
        }
      : undefined;

  const timestamp = new Date().toISOString();
  const report = {
    metadata: {
      evaluationTimestamp: timestamp,
      status: multiMetrics.status,
      configuredRepositoryCount: loadedDatasets.length,
      completedRepositoryCount: multiMetrics.completedRepositoryCount,
      failedRepositoryCount: multiMetrics.failedRepositoryCount,
      topK,
      retrievalMethod: "vector",
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
      datasets: loadedDatasets.map((loaded) => ({
        fileName: loaded.fileName,
        ...(loaded.dataset
          ? {
              datasetId: loaded.dataset.datasetId,
              version: loaded.dataset.version,
              repository: loaded.dataset.repository,
            }
          : { failureReason: loaded.failureReason }),
      })),
    },
    overallAggregateMetrics,
    ...(partialDiagnostics ? { partialDiagnostics } : {}),
    totalAnswerableQuestionCount: countQuestions(loadedDatasets, true),
    totalUnanswerableQuestionCount: countQuestions(loadedDatasets, false),
    repositoryCount: loadedDatasets.length,
    repositories: repositoryResults.map(
      ({ questionMetrics: _questionMetrics, ...repository }) => repository,
    ),
  };

  await mkdir(resultsDirectory, { recursive: true });
  const outputPath = resolve(
    resultsDirectory,
    `${timestamp.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Repositories: ${loadedDatasets.length}`);
  console.log(`Completed: ${multiMetrics.completedRepositoryCount}`);
  console.log(`Failed: ${multiMetrics.failedRepositoryCount}`);
  if (overallAggregateMetrics) {
    console.log("\nQuestion-weighted:");
    console.log(
      `Recall@${topK}: ${overallAggregateMetrics.questionWeighted?.[`Recall@${topK}`]?.toFixed(4)}`,
    );
    console.log(
      `MRR@${topK}: ${overallAggregateMetrics.questionWeighted?.[`MRR@${topK}`]?.toFixed(4)}`,
    );
    console.log(
      `nDCG@${topK}: ${overallAggregateMetrics.questionWeighted?.[`nDCG@${topK}`]?.toFixed(4)}`,
    );
    console.log("\nRepository-weighted:");
    console.log(
      `Recall@${topK}: ${overallAggregateMetrics.repositoryWeighted?.[`Recall@${topK}`]?.toFixed(4)}`,
    );
    console.log(
      `MRR@${topK}: ${overallAggregateMetrics.repositoryWeighted?.[`MRR@${topK}`]?.toFixed(4)}`,
    );
    console.log(
      `nDCG@${topK}: ${overallAggregateMetrics.repositoryWeighted?.[`nDCG@${topK}`]?.toFixed(4)}`,
    );
  } else {
    for (const repository of repositoryResults) {
      if (repository.status === "failed") {
        console.error(
          `Failed: ${repository.repository ? `${repository.repository.owner}/${repository.repository.name}` : repository.datasetFile} — ${repository.failureReason}`,
        );
      }
    }
  }
  console.log(`\nReport: ${outputPath}`);
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
