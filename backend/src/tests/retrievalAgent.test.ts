import assert from "node:assert/strict";
import test from "node:test";
import { invokeFunctionTool, RunContext, type FunctionTool } from "@openai/agents";
import {
  collectUsefulChunks,
  defaultRetrievalBudget,
  runRetrievalAgent,
} from "../services/retrievalAgent.js";
import type { RetrievedChunk } from "../services/conversationFlow.js";

function chunk(id: string, content = `content ${id}`): RetrievedChunk {
  return {
    id,
    filePath: `src/${id}.ts`,
    content,
    startLine: 1,
    endLine: 3,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  };
}

test("deduplicates chunks and preserves metadata", () => {
  const first = chunk("a");
  const collected = collectUsefulChunks([first], [first, chunk("b")], defaultRetrievalBudget);

  assert.deepEqual(collected.map((item) => item.id), ["a", "b"]);
  assert.equal(collected[1].filePath, "src/b.ts");
  assert.equal(collected[1].commitSha, first.commitSha);
});

test("enforces unique chunk and context budgets", () => {
  const budget = { ...defaultRetrievalBudget, maxUniqueChunks: 2, maxContextTokens: 20 };
  const collected = collectUsefulChunks([], [
    chunk("a", "12345678"),
    chunk("b", "12345678"),
    chunk("c", "123456789012345678901234567890"),
  ], budget);

  assert.deepEqual(collected.map((item) => item.id), ["a", "b"]);
});

test("uses the authorized branch and caps the search limit", async () => {
  let searchedBranch = "";
  let searchedLimit = 0;
  let agentInstructions = "";
  const mockRun = (async (agent: any) => {
    agentInstructions = agent.instructions;
    const searchTool = agent.tools[0] as FunctionTool;
    await invokeFunctionTool({
      tool: searchTool,
      runContext: new RunContext(),
      input: JSON.stringify({ query: "login flow", limit: 999 }),
    });
    return { finalOutput: { status: "sufficient" } };
  }) as any;

  await runRetrievalAgent(
    "How does login work?",
    "authorized-branch-id",
    {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
    },
    async (branchId, query, limit) => {
      searchedBranch = branchId;
      searchedLimit = limit;
      assert.equal(query, "login flow");
      return [chunk("login")];
    },
    mockRun,
  );

  assert.equal(searchedBranch, "authorized-branch-id");
  assert.equal(searchedLimit, defaultRetrievalBudget.maxChunksPerSearch);
  assert.match(agentInstructions, /source code together with available contextual metadata/);
  assert.match(agentInstructions, /include that known information/);
  assert.match(agentInstructions, /Never invent file paths, class names, or symbol names/);
});

test("one search can be sufficient and another search can refine evidence", async () => {
  const queries: string[] = [];
  const sufficientRun = (async (agent: any) => {
    const searchTool = agent.tools[0] as FunctionTool;
    await invokeFunctionTool({
      tool: searchTool,
      runContext: new RunContext(),
      input: JSON.stringify({ query: "authentication entry point", limit: 5 }),
    });
    return { finalOutput: { status: "sufficient" } };
  }) as any;

  await runRetrievalAgent(
    "How is authentication initialized?",
    "branch-id",
    { apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "test-model" },
    async (_branchId, query) => {
      queries.push(query);
      return [chunk(`auth-${queries.length}`)];
    },
    sufficientRun,
  );
  assert.deepEqual(queries, ["authentication entry point"]);

  const refinedRun = (async (agent: any) => {
    const searchTool = agent.tools[0] as FunctionTool;
    for (const query of ["authentication", "session middleware"]) {
      await invokeFunctionTool({
        tool: searchTool,
        runContext: new RunContext(),
        input: JSON.stringify({ query, limit: 4 }),
      });
    }
    return { finalOutput: { status: "sufficient" } };
  }) as any;

  await runRetrievalAgent(
    "How is authentication initialized?",
    "branch-id",
    { apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "test-model" },
    async (_branchId, query) => {
      queries.push(query);
      return [chunk(`refined-${queries.length}`)];
    },
    refinedRun,
  );
  assert.deepEqual(queries.slice(1), ["authentication", "session middleware"]);
});

test("invalid agent output and empty evidence are treated as insufficient", async () => {
  const mockRun = (async () => ({ finalOutput: "not structured" })) as any;
  const outcome = await runRetrievalAgent(
    "missing behavior",
    "branch-id",
    { apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "test-model" },
    async () => [],
    mockRun,
  );

  assert.equal(outcome.status, "insufficient");
  assert.equal(outcome.chunks.length, 0);
  assert.equal(outcome.searchCalls, 0);
});

test("maximum search calls are enforced independently of agent turns", async () => {
  const mockRun = (async (agent: any) => {
    const searchTool = agent.tools[0] as FunctionTool;
    for (let index = 0; index < 6; index += 1) {
      await invokeFunctionTool({
        tool: searchTool,
        runContext: new RunContext(),
        input: JSON.stringify({ query: `query-${index}`, limit: 2 }),
      });
    }
    return { finalOutput: { status: "insufficient" } };
  }) as any;

  let calls = 0;
  const outcome = await runRetrievalAgent(
    "Find it",
    "branch-id",
    {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
      budget: { maxSearchCalls: 3, maxAgentTurns: 100 },
    },
    async () => {
      calls += 1;
      return [];
    },
    mockRun,
  );

  assert.equal(calls, 3);
  assert.equal(outcome.searchCalls, 3);
});
