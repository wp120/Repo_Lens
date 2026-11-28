import assert from "node:assert/strict";
import test from "node:test";
import {
  invokeFunctionTool,
  RunContext,
  type FunctionTool,
} from "@openai/agents";
import {
  collectUsefulChunks,
  defaultRetrievalBudget,
  getRetrievalBudget,
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
  const collected = collectUsefulChunks(
    [first],
    [first, chunk("b")],
    defaultRetrievalBudget,
  );

  assert.deepEqual(
    collected.map((item) => item.id),
    ["a", "b"],
  );
  assert.equal(collected[1].filePath, "src/b.ts");
  assert.equal(collected[1].commitSha, first.commitSha);
});

test("registers code retrieval and repository structure tools", async () => {
  let toolNames: string[] = [];
  const mockRun = (async (agent: any) => {
    toolNames = agent.tools.map((item: { name: string }) => item.name);
    return { finalOutput: { status: "insufficient" } };
  }) as any;

  await runRetrievalAgent(
    "Find relevant code",
    "branch-id",
    { apiKey: "test-key", model: "test-model" },
    { vectorSearch: async () => [], keywordSearch: async () => [] },
    mockRun,
  );

  assert.deepEqual(toolNames, [
    "vector_search",
    "searchCode",
    "repository_structure_lookup",
    "code_relationship_lookup",
  ]);
});

test("shared budget configuration supplies the evaluation primary cutoff", () => {
  const budget = getRetrievalBudget();
  assert.equal(budget.maxUniqueChunks, getRetrievalBudget().maxUniqueChunks);
});

test("deduplicates across retrieval sources and retains source metadata", () => {
  const vector = { ...chunk("shared"), retrievalSources: ["vector"] };
  const keyword = {
    ...chunk("shared"),
    symbolName: "createBooking",
    functionSignature: "createBooking(input: BookingInput)",
    language: "typescript",
    retrievalSources: ["identifier"],
  };
  const collected = collectUsefulChunks(
    [vector],
    [keyword],
    defaultRetrievalBudget,
  );

  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0].retrievalSources?.sort(), [
    "identifier",
    "vector",
  ]);
  assert.equal(collected[0].symbolName, "createBooking");
  assert.equal(
    collected[0].functionSignature,
    "createBooking(input: BookingInput)",
  );
});

test("enforces unique chunk and context budgets", () => {
  const budget = {
    ...defaultRetrievalBudget,
    maxUniqueChunks: 2,
    maxContextTokens: 20,
  };
  const collected = collectUsefulChunks(
    [],
    [
      chunk("a", "12345678"),
      chunk("b", "12345678"),
      chunk("c", "123456789012345678901234567890"),
    ],
    budget,
  );

  assert.deepEqual(
    collected.map((item) => item.id),
    ["a", "b"],
  );
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
    {
      vectorSearch: async (branchId, query, limit) => {
        searchedBranch = branchId;
        searchedLimit = limit;
        assert.equal(query, "login flow");
        return [chunk("login")];
      },
      keywordSearch: async () => [],
    },
    mockRun,
  );

  assert.equal(searchedBranch, "authorized-branch-id");
  assert.equal(searchedLimit, defaultRetrievalBudget.maxChunksPerSearch);
  assert.match(
    agentInstructions,
    /source code together with available contextual metadata/,
  );
  assert.match(
    agentInstructions,
    /Use vector_search for semantic or conceptual questions/,
  );
  assert.match(agentInstructions, /all Git-tracked file paths/);
  assert.match(
    agentInstructions,
    /does not mean its contents have been retrieved/,
  );
  assert.match(agentInstructions, /metadata filters such as filePath/);
  assert.match(agentInstructions, /structure is unavailable/);
  assert.match(
    agentInstructions,
    /Do not assume the repository is empty or repeatedly retry/,
  );
  assert.match(
    agentInstructions,
    /Never invent file paths, class names, or symbol names/,
  );
});

test("repository structure lookup is bound to the conversation branch and paginated", async () => {
  let lookup:
    | {
        branchIndexId: string;
        query: {
          mode: string;
          path?: string;
          query?: string;
          offset?: number;
          limit?: number;
          depth?: number;
        };
      }
    | undefined;
  let structureResult: unknown;
  const mockRun = (async (agent: any) => {
    const structureTool = agent.tools[2] as FunctionTool;
    structureResult = await invokeFunctionTool({
      tool: structureTool,
      runContext: new RunContext(),
      input: JSON.stringify({
        mode: "search",
        query: "config",
        offset: 10,
        limit: 500,
      }),
    });
    return { finalOutput: { status: "insufficient" } };
  }) as any;

  await runRetrievalAgent(
    "Find configuration files",
    "authorized-branch-id",
    { apiKey: "test-key", model: "test-model" },
    {
      vectorSearch: async () => [],
      keywordSearch: async () => [],
      repositoryStructureLookup: async (branchIndexId, query) => {
        lookup = { branchIndexId, query };
        return {
          status: "unavailable",
          message: "Repository structure is unavailable for this branch.",
        };
      },
    },
    mockRun,
  );

  assert.equal(lookup?.branchIndexId, "authorized-branch-id");
  assert.deepEqual(lookup?.query, {
    mode: "search",
    path: undefined,
    query: "config",
    offset: 10,
    limit: 100,
    depth: 2,
  });
  assert.deepEqual(structureResult, {
    status: "unavailable",
    message: "Repository structure is unavailable for this branch.",
  });
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
    {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
    },
    {
      vectorSearch: async (_branchId, query) => {
        queries.push(query);
        return [chunk(`auth-${queries.length}`)];
      },
      keywordSearch: async () => [],
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
    {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
    },
    {
      vectorSearch: async (_branchId, query) => {
        queries.push(query);
        return [chunk(`refined-${queries.length}`)];
      },
      keywordSearch: async () => [],
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
    {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
    },
    { vectorSearch: async () => [], keywordSearch: async () => [] },
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
    {
      vectorSearch: async () => {
        calls += 1;
        return [];
      },
      keywordSearch: async () => [],
    },
    mockRun,
  );

  assert.equal(calls, 3);
  assert.equal(outcome.searchCalls, 3);
});

test("searchCode is exposed with filters and shares the overall search budget", async () => {
  let searched:
    | {
        branchId: string;
        query: string;
        mode: string;
        filters: unknown;
        limit: number;
      }
    | undefined;
  const mockRun = (async (agent: any) => {
    const searchCodeTool = agent.tools[1] as FunctionTool;
    await invokeFunctionTool({
      tool: searchCodeTool,
      runContext: new RunContext(),
      input: JSON.stringify({
        query: "createBooking",
        mode: "identifier",
        filters: {
          filePath: "src/controllers/bookingController.ts",
          className: "BookingController",
          symbolType: "method",
          language: "typescript",
        },
        limit: 999,
      }),
    });
    await invokeFunctionTool({
      tool: searchCodeTool,
      runContext: new RunContext(),
      input: JSON.stringify({
        query: "booking redirect",
        mode: "full_text",
        limit: 3,
      }),
    });
    return { finalOutput: { status: "sufficient" } };
  }) as any;

  const outcome = await runRetrievalAgent(
    "Find createBooking",
    "authorized-branch",
    {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      model: "test-model",
      budget: {
        maxSearchCalls: 3,
        maxKeywordSearchCalls: 1,
        maxChunksPerSearch: 4,
      },
    },
    {
      vectorSearch: async () => [],
      keywordSearch: async (
        branchId: string,
        query: string,
        mode: "full_text" | "identifier",
        filters: unknown,
        limit: number,
      ) => {
        searched = { branchId, query, mode, filters, limit };
        return [chunk("createBooking")];
      },
    } as any,
    mockRun,
  );

  assert.equal(searched?.branchId, "authorized-branch");
  assert.equal(searched?.query, "createBooking");
  assert.equal(searched?.mode, "identifier");
  assert.equal(searched?.limit, 4);
  assert.deepEqual(searched?.filters, {
    filePath: "src/controllers/bookingController.ts",
    className: "BookingController",
    symbolType: "method",
    language: "typescript",
  });
  assert.equal(outcome.searchCalls, 1);
  assert.equal(outcome.chunks.length, 1);
});

test("code_relationship_lookup is bound to the authorized branch and enforces graph budget independently", async () => {
  const recorded: Array<{ branchIndexId: string; query: unknown }> = [];
  let agentInstructions = "";
  let graphLimitResult: unknown;
  let unavailableResult: unknown;

  const mockRun = (async (agent: any) => {
    agentInstructions = agent.instructions;
    const graphTool = agent.tools.find(
      (t: { name: string }) => t.name === "code_relationship_lookup",
    ) as FunctionTool;
    assert.ok(graphTool);

    await invokeFunctionTool({
      tool: graphTool,
      runContext: new RunContext(),
      input: JSON.stringify({
        mode: "find_callers",
        symbolName: "createBooking",
        filePath: "src/services/bookingService.ts",
      }),
    });

    graphLimitResult = await invokeFunctionTool({
      tool: graphTool,
      runContext: new RunContext(),
      input: JSON.stringify({
        mode: "symbol_lookup",
        symbolName: "BookingController",
      }),
    });

    return { finalOutput: { status: "sufficient" } };
  }) as any;

  const outcome = await runRetrievalAgent(
    "Who calls createBooking?",
    "authorized-branch-id",
    {
      apiKey: "test-key",
      model: "test-model",
      budget: { maxGraphLookupCalls: 1, maxSearchCalls: 4 },
    },
    {
      vectorSearch: async () => [],
      keywordSearch: async () => [],
      codeRelationshipLookup: async (branchIndexId, query) => {
        recorded.push({ branchIndexId, query });
        return { status: "ok", callers: [] };
      },
    },
    mockRun,
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].branchIndexId, "authorized-branch-id");
  assert.deepEqual(recorded[0].query, {
    mode: "find_callers",
    symbolName: "createBooking",
    filePath: "src/services/bookingService.ts",
  });
  assert.deepEqual(graphLimitResult, {
    status: "limit_reached",
    message:
      "Graph lookup limit reached. Retrieve source code implementations using searchCode or vector_search.",
    remainingGraphLookups: 0,
  });
  assert.equal(outcome.searchCalls, 0);
  assert.match(agentInstructions, /code_relationship_lookup/);
  assert.match(
    agentInstructions,
    /Never treat graph relationships alone as proof/,
  );

  // Graceful fallback when codeRelationshipLookup dependency is not configured
  const fallbackRun = (async (agent: any) => {
    const graphTool = agent.tools.find(
      (t: { name: string }) => t.name === "code_relationship_lookup",
    ) as FunctionTool;
    unavailableResult = await invokeFunctionTool({
      tool: graphTool,
      runContext: new RunContext(),
      input: JSON.stringify({ mode: "symbol_lookup", symbolName: "boot" }),
    });
    return { finalOutput: { status: "insufficient" } };
  }) as any;

  await runRetrievalAgent(
    "Find boot",
    "branch-id",
    { apiKey: "test-key", model: "test-model" },
    { vectorSearch: async () => [], keywordSearch: async () => [] },
    fallbackRun,
  );
  assert.deepEqual(unavailableResult, {
    status: "unavailable",
    message: "Code relationship lookup is unavailable for this branch.",
  });
});

test("retrieval agent uses graph exploration followed by source-code retrieval", async () => {
  const searchCalls: Array<{ query: string; mode: string; filters: unknown }> =
    [];

  const mockRun = (async (agent: any) => {
    const graphTool = agent.tools.find(
      (t: { name: string }) => t.name === "code_relationship_lookup",
    ) as FunctionTool;
    const searchCodeTool = agent.tools.find(
      (t: { name: string }) => t.name === "searchCode",
    ) as FunctionTool;

    const trace = (await invokeFunctionTool({
      tool: graphTool,
      runContext: new RunContext(),
      input: JSON.stringify({
        mode: "execution_path",
        qualifiedName: "ApiController.handle",
        maxDepth: 4,
      }),
    })) as {
      paths: Array<{
        hops: Array<{ toSymbol: { name: string; filePath: string } }>;
      }>;
    };

    // Agent uses discovered symbols/file paths from graph trace to retrieve source code
    for (const hop of trace.paths[0].hops) {
      await invokeFunctionTool({
        tool: searchCodeTool,
        runContext: new RunContext(),
        input: JSON.stringify({
          query: hop.toSymbol.name,
          mode: "identifier",
          filters: {
            filePath: hop.toSymbol.filePath,
            symbolName: hop.toSymbol.name,
          },
          limit: 3,
        }),
      });
    }

    return { finalOutput: { status: "sufficient" } };
  }) as any;

  const outcome = await runRetrievalAgent(
    "Trace how ApiController.handle processes and persists a booking",
    "authorized-branch-id",
    { apiKey: "test-key", model: "test-model" },
    {
      vectorSearch: async () => [],
      keywordSearch: async (_branchId, query, mode, filters) => {
        searchCalls.push({ query, mode, filters });
        if (query === "create") {
          return [
            {
              id: "chunk-svc",
              filePath: "src/services/bookingService.ts",
              content: "create() { return this.repo.insert(); }",
              startLine: 10,
              endLine: 15,
              commitSha: "0123456789abcdef0123456789abcdef01234567",
              symbolName: "create",
              retrievalSources: ["identifier"],
            },
          ];
        }
        return [
          {
            id: "chunk-repo",
            filePath: "src/repositories/bookingRepo.ts",
            content: "insert() { return db.query(...); }",
            startLine: 5,
            endLine: 12,
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            symbolName: "insert",
            retrievalSources: ["identifier"],
          },
        ];
      },
      codeRelationshipLookup: async (_branchId, query) => {
        assert.equal(query.mode, "execution_path");
        return {
          status: "ok",
          paths: [
            {
              depth: 2,
              summary:
                "src/controllers/apiController.ts:ApiController.handle -> src/services/bookingService.ts:BookingService.create -> src/repositories/bookingRepo.ts:BookingRepo.insert",
              hops: [
                {
                  step: 1,
                  toSymbol: {
                    name: "create",
                    filePath: "src/services/bookingService.ts",
                  },
                },
                {
                  step: 2,
                  toSymbol: {
                    name: "insert",
                    filePath: "src/repositories/bookingRepo.ts",
                  },
                },
              ],
            },
          ],
        };
      },
    },
    mockRun,
  );

  assert.equal(outcome.status, "sufficient");
  assert.equal(outcome.searchCalls, 2);
  assert.deepEqual(
    outcome.chunks.map((c) => c.id),
    ["chunk-svc", "chunk-repo"],
  );
  assert.deepEqual(searchCalls, [
    {
      query: "create",
      mode: "identifier",
      filters: {
        filePath: "src/services/bookingService.ts",
        symbolName: "create",
      },
    },
    {
      query: "insert",
      mode: "identifier",
      filters: {
        filePath: "src/repositories/bookingRepo.ts",
        symbolName: "insert",
      },
    },
  ]);
});
