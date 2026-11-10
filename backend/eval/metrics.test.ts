import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMacroMetrics,
  calculateQuestionMetrics,
} from "./metrics.js";

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
