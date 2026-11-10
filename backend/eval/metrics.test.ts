import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMacroMetrics,
  calculateMultiRepositoryMetrics,
  calculateQuestionMetrics,
  getOfficialMultiRepositoryMetrics,
} from "./metrics.js";
import { normalizeDataset } from "./datasets.js";

test("retrieval metrics avoid counting evidence matched by multiple chunks twice", () => {
  const metrics = calculateQuestionMetrics(
    [
      { id: "evidence-1", relevance: 3 },
      { id: "evidence-2", relevance: 1 },
    ],
    [
      { matchedEvidenceIds: [] },
      { matchedEvidenceIds: ["evidence-1", "evidence-2"] },
      { matchedEvidenceIds: ["evidence-1"] },
    ],
    3,
  );

  assert.equal(metrics.recall, 1);
  assert.equal(metrics.mrr, 0.5);
  assert.deepEqual(metrics.relevanceGrades, [0, 3, 0]);
  const expectedNdcg =
    (7 / Math.log2(3)) / (7 + 1 / Math.log2(3));
  assert.ok(Math.abs(metrics.ndcg - expectedNdcg) < 1e-12);
});

test("retrieval metrics return zeros when no expected evidence is retrieved", () => {
  const metrics = calculateQuestionMetrics(
    [{ id: "evidence-1", relevance: 2 }],
    [{ matchedEvidenceIds: [] }],
    1,
  );

  assert.deepEqual(metrics, {
    recall: 0,
    mrr: 0,
    ndcg: 0,
    relevanceGrades: [0],
  });
});

test("macro metrics average answerable-question metrics", () => {
  const result = calculateMacroMetrics([
    { recall: 1, mrr: 0.5, ndcg: 0.75, relevanceGrades: [] },
    { recall: 0, mrr: 0, ndcg: 0.25, relevanceGrades: [] },
  ]);
  assert.deepEqual(result, { recall: 0.5, mrr: 0.25, ndcg: 0.5 });
});

function datasetFixture(question: Record<string, unknown>) {
  return {
    datasetId: "test-dataset",
    version: "1.0.0",
    repository: {
      owner: "owner",
      name: "repo",
      url: "https://github.com/owner/repo",
      branch: "main",
      commitSha: null,
    },
    questions: [question],
  };
}

test("dataset normalization reads the canonical answerable and symbol fields", () => {
  const dataset = normalizeDataset(
    datasetFixture({
      id: "CHI01",
      question: "Question?",
      answerable: true,
      expectedEvidence: [
        {
          id: "CHI01-EXPLICIT",
          filePath: "mux.go",
          symbol: "NewMux",
          relevance: 3,
        },
      ],
    }),
    "canonical.json",
  );
  assert.equal(dataset.questions[0].answerable, true);
  assert.deepEqual(dataset.questions[0].expectedEvidence[0], {
    id: "CHI01-EXPLICIT",
    filePath: "mux.go",
    symbol: "NewMux",
    relevance: 3,
  });
});

test("dataset normalization requires and preserves explicit evidence IDs", () => {
  const dataset = normalizeDataset(
    datasetFixture({
      id: "Q1",
      question: "Question?",
      answerable: true,
      expectedEvidence: [
        {
          id: "kept",
          filePath: "src/lib.rs",
          relevance: 3,
        },
        {
          id: "also-kept",
          filePath: "src/context.rs",
          relevance: 2,
        },
      ],
    }),
    "dataset.json",
  );
  assert.deepEqual(
    dataset.questions[0].expectedEvidence.map((item) => item.id),
    ["kept", "also-kept"],
  );
  assert.throws(
    () =>
      normalizeDataset(
        datasetFixture({
          id: "Q1",
          question: "Question?",
          shouldBeAnswerable: true,
          expectedEvidence: [
            { id: "e1", filePath: "file.ts", symbol: "x", relevance: 3 },
          ],
        }),
        "legacy-answerability.json",
      ),
    /Unexpected field "shouldBeAnswerable"/,
  );
  assert.throws(
    () =>
      normalizeDataset(
        datasetFixture({
          id: "Q1",
          question: "Question?",
          answerable: true,
          expectedEvidence: [
            {
              id: "e1",
              filePath: "file.ts",
              symbolName: "legacy",
              relevance: 3,
            },
          ],
        }),
        "legacy-symbol.json",
      ),
    /Unexpected field "symbolName"/,
  );
  assert.throws(
    () =>
      normalizeDataset(
        datasetFixture({
          id: "Q1",
          question: "Question?",
          answerable: true,
          expectedEvidence: [{ filePath: "file.ts", relevance: 3 }],
        }),
        "missing-evidence-id.json",
      ),
    /Missing or invalid evidence ID/,
  );
});

function questionMetrics(recall: number, mrr: number, ndcg: number) {
  return { recall, mrr, ndcg, relevanceGrades: [] };
}

test("multi-repository aggregation computes question- and repository-weighted averages", () => {
  const aggregate = calculateMultiRepositoryMetrics([
    {
      status: "completed",
      questions: [
        { answerable: true, metrics: questionMetrics(1, 0.5, 0.75) },
        { answerable: true, metrics: questionMetrics(0, 0, 0.25) },
        { answerable: false, metrics: questionMetrics(1, 1, 1) },
      ],
    },
    {
      status: "completed",
      questions: [
        { answerable: true, metrics: questionMetrics(0.25, 0.5, 0.5) },
      ],
    },
  ]);
  assert.equal(aggregate.status, "completed");
  assert.equal(aggregate.questionWeighted?.recall, 1.25 / 3);
  assert.equal(aggregate.questionWeighted?.mrr, 1 / 3);
  assert.equal(aggregate.questionWeighted?.ndcg, 0.5);
  assert.equal(aggregate.repositoryWeighted?.recall, 0.375);
  assert.equal(aggregate.repositoryWeighted?.mrr, 0.375);
  assert.equal(aggregate.repositoryWeighted?.ndcg, 0.5);
});

test("multi-repository aggregation exposes partial diagnostics and excludes failed repositories", () => {
  const partial = calculateMultiRepositoryMetrics([
    {
      status: "completed",
      questions: [
        { answerable: true, metrics: questionMetrics(0.5, 0.25, 0.75) },
      ],
    },
    {
      status: "failed",
      questions: [
        { answerable: true, metrics: questionMetrics(1, 1, 1) },
      ],
    },
  ]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.completedRepositoryCount, 1);
  assert.equal(partial.failedRepositoryCount, 1);
  assert.deepEqual(partial.questionWeighted, {
    recall: 0.5,
    mrr: 0.25,
    ndcg: 0.75,
  });
  assert.equal(getOfficialMultiRepositoryMetrics(partial, 2), null);

  const failed = calculateMultiRepositoryMetrics([
    { status: "failed", questions: [] },
  ]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.questionWeighted, null);
  assert.equal(failed.repositoryWeighted, null);
  assert.equal(getOfficialMultiRepositoryMetrics(failed, 1), null);
});
