import { Agent, OpenAIProvider, run, tool } from "@openai/agents";
import { z } from "zod";
import type { RetrievedChunk } from "./conversationFlow.js";
import type { CodeSearchFilters, CodeSearchMode } from "./retrieval.js";

export interface RetrievalBudget {
  maxSearchCalls: number;
  maxChunksPerSearch: number;
  maxUniqueChunks: number;
  maxContextTokens: number;
  maxAgentTurns: number;
  maxKeywordSearchCalls: number;
}

export interface RetrievalOutcome<TChunk extends RetrievedChunk = RetrievedChunk> {
  status: "sufficient" | "insufficient";
  chunks: TChunk[];
  searchCalls: number;
}

export interface RetrievalAgentConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  budget?: Partial<RetrievalBudget>;
}

interface RetrievalRunState<TChunk extends RetrievedChunk> {
  calls: number;
  keywordCalls: number;
  chunks: TChunk[];
  chunkIds: Set<string>;
  contextTokens: number;
}

export type SearchCodeFunction<TChunk extends RetrievedChunk = RetrievedChunk> = (
  branchIndexId: string,
  query: string,
  mode: CodeSearchMode,
  filters: CodeSearchFilters,
  limit: number,
) => Promise<TChunk[]>;

export interface RetrievalDependencies<TChunk extends RetrievedChunk = RetrievedChunk> {
  vectorSearch: (
    branchIndexId: string,
    query: string,
    limit: number,
  ) => Promise<TChunk[]>;
  repositoryStructureLookup?: (
    branchIndexId: string,
    query: {
      mode: "overview" | "list_directory" | "tree" | "search";
      path?: string;
      query?: string;
      offset?: number;
      limit?: number;
      depth?: number;
    },
  ) => Promise<Record<string, unknown>>;
  keywordSearch: SearchCodeFunction<TChunk>;
}

export const defaultRetrievalBudget: RetrievalBudget = {
  maxSearchCalls: 4,
  maxChunksPerSearch: 10,
  maxUniqueChunks: 25,
  maxContextTokens: 12000,
  maxAgentTurns: 12,
  maxKeywordSearchCalls: 4,
};

export function getRetrievalBudget(
  overrides: Partial<RetrievalBudget> = {},
): RetrievalBudget {
  const env = process.env;
  const configured = {
    maxSearchCalls: positiveInteger(
      env.RETRIEVAL_MAX_SEARCH_CALLS,
      defaultRetrievalBudget.maxSearchCalls,
    ),
    maxChunksPerSearch: positiveInteger(
      env.RETRIEVAL_MAX_CHUNKS_PER_SEARCH,
      defaultRetrievalBudget.maxChunksPerSearch,
    ),
    maxUniqueChunks: positiveInteger(
      env.RETRIEVAL_MAX_UNIQUE_CHUNKS,
      defaultRetrievalBudget.maxUniqueChunks,
    ),
    maxContextTokens: positiveInteger(
      env.RETRIEVAL_MAX_CONTEXT_TOKENS,
      defaultRetrievalBudget.maxContextTokens,
    ),
    maxAgentTurns: positiveInteger(
      env.RETRIEVAL_MAX_AGENT_TURNS,
      defaultRetrievalBudget.maxAgentTurns,
    ),
    maxKeywordSearchCalls: positiveInteger(
      env.RETRIEVAL_MAX_KEYWORD_SEARCH_CALLS,
      defaultRetrievalBudget.maxKeywordSearchCalls,
    ),
  };
  return { ...configured, ...overrides };
}

export function chunkIdentity(chunk: RetrievedChunk): string {
  return chunk.id?.trim()
    || `${chunk.commitSha}:${chunk.filePath}:${chunk.startLine}-${chunk.endLine}:${chunk.content}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function collectUsefulChunks<TChunk extends RetrievedChunk>(
  existing: TChunk[],
  candidates: TChunk[],
  budget: RetrievalBudget,
): TChunk[] {
  const seen = new Set(existing.map(chunkIdentity));
  let tokens = existing.reduce((total, chunk) => total + estimateTokens(chunk.content), 0);
  const collected = [...existing];

  for (const chunk of candidates) {
    if (!chunk.content.trim()) continue;
    const id = chunkIdentity(chunk);
    if (seen.has(id)) {
      const existingIndex = collected.findIndex((item) => chunkIdentity(item) === id);
      if (existingIndex >= 0) {
        const existingChunk = collected[existingIndex];
        const sources = new Set([
          ...(existingChunk.retrievalSources ?? []),
          ...(chunk.retrievalSources ?? []),
        ]);
        collected[existingIndex] = { ...existingChunk, ...chunk, retrievalSources: [...sources] } as TChunk;
      }
      continue;
    }
    const tokensForChunk = estimateTokens(chunk.content);
    if (collected.length >= budget.maxUniqueChunks) break;
    if (tokens + tokensForChunk > budget.maxContextTokens) continue;
    seen.add(id);
    collected.push(chunk);
    tokens += tokensForChunk;
  }
  return collected;
}

const retrievalOutcomeSchema = z.object({
  status: z.enum(["sufficient", "insufficient"]),
});

export async function runRetrievalAgent<TChunk extends RetrievedChunk = RetrievedChunk>(
  question: string,
  branchIndexId: string,
  config: RetrievalAgentConfig,
  dependencies: RetrievalDependencies<TChunk>,
  runAgent: typeof run = run,
): Promise<RetrievalOutcome<TChunk>> {
  const { vectorSearch: vectorSearchDependency, keywordSearch } = dependencies;
  const repositoryStructureLookup = dependencies.repositoryStructureLookup;
  const budget = getRetrievalBudget(config.budget);
  const state: RetrievalRunState<TChunk> = {
    calls: 0,
    keywordCalls: 0,
    chunks: [],
    chunkIds: new Set(),
    contextTokens: 0,
  };

  const vectorSearch = tool({
    name: "vector_search",
    description: "Search the authorized branch index for relevant code chunks.",
    parameters: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive(),
    }).strict(),
    strict: true,
    execute: async ({ query, limit }) => {
      if (state.calls >= budget.maxSearchCalls) {
        return { chunks: [], newChunks: 0, remainingSearches: 0, limitReached: true };
      }
      state.calls += 1;
      const cappedLimit = Math.min(
        Math.max(1, Math.floor(limit)),
        budget.maxChunksPerSearch,
      );
      const found = await vectorSearchDependency(branchIndexId, query.trim(), cappedLimit);
      const before = state.chunks.length;
      const beforeIds = new Set(state.chunks.map(chunkIdentity));
      state.chunks = collectUsefulChunks(state.chunks, found, budget);
      state.contextTokens = state.chunks.reduce(
        (total, chunk) => total + estimateTokens(chunk.content),
        0,
      );
      state.chunks.forEach((chunk) => state.chunkIds.add(chunkIdentity(chunk)));
      const newChunks = state.chunks.length - before;
      const newChunkResults = state.chunks.filter(
        (chunk) => !beforeIds.has(chunkIdentity(chunk)),
      );

      return {
        chunks: newChunkResults,
        newChunks,
        remainingSearches: Math.max(0, budget.maxSearchCalls - state.calls),
        uniqueChunkCount: state.chunks.length,
        remainingChunkCapacity: Math.max(0, budget.maxUniqueChunks - state.chunks.length),
        contextTokens: state.contextTokens,
        remainingContextTokenCapacity: Math.max(0, budget.maxContextTokens - state.contextTokens),
        limitReached: state.calls >= budget.maxSearchCalls
          || state.chunks.length >= budget.maxUniqueChunks
          || state.contextTokens >= budget.maxContextTokens,
      };
    },
  });

  const searchCodeTool = tool({
        name: "searchCode",
        description: "Search PostgreSQL text or exact code identifiers in the authorized branch index.",
        parameters: z.object({
          query: z.string().min(1),
          mode: z.enum(["full_text", "identifier"]),
          filters: z.object({
            filePath: z.string().min(1).optional(),
            className: z.string().min(1).optional(),
            symbolName: z.string().min(1).optional(),
            symbolType: z.string().min(1).optional(),
            language: z.string().min(1).optional(),
          }).strict().optional(),
          limit: z.number().int().positive(),
        }).strict(),
        strict: true,
        execute: async ({ query, mode, filters, limit }) => {
          if (
            state.calls >= budget.maxSearchCalls
            || state.keywordCalls >= budget.maxKeywordSearchCalls
          ) {
            return { chunks: [], newChunks: 0, remainingSearches: 0, limitReached: true };
          }
          state.calls += 1;
          state.keywordCalls += 1;
          const cappedLimit = Math.min(
            Math.max(1, Math.floor(limit)),
            budget.maxChunksPerSearch,
          );
          const found = await keywordSearch(
            branchIndexId,
            query.trim(),
            mode,
            filters ?? {},
            cappedLimit,
          );
          const before = state.chunks.length;
          const beforeIds = new Set(state.chunks.map(chunkIdentity));
          state.chunks = collectUsefulChunks(state.chunks, found, budget);
          state.contextTokens = state.chunks.reduce(
            (total, chunk) => total + estimateTokens(chunk.content),
            0,
          );
          const newChunks = state.chunks.length - before;
          const newChunkResults = state.chunks.filter(
            (chunk) => !beforeIds.has(chunkIdentity(chunk)),
          );
          return {
            chunks: newChunkResults,
            newChunks,
            remainingSearches: Math.max(0, budget.maxSearchCalls - state.calls),
            remainingKeywordSearches: Math.max(
              0,
              budget.maxKeywordSearchCalls - state.keywordCalls,
            ),
            uniqueChunkCount: state.chunks.length,
            remainingChunkCapacity: Math.max(0, budget.maxUniqueChunks - state.chunks.length),
            contextTokens: state.contextTokens,
            remainingContextTokenCapacity: Math.max(0, budget.maxContextTokens - state.contextTokens),
            limitReached: state.calls >= budget.maxSearchCalls
              || state.keywordCalls >= budget.maxKeywordSearchCalls
              || state.chunks.length >= budget.maxUniqueChunks
              || state.contextTokens >= budget.maxContextTokens,
          };
        },
      });

  const repositoryStructureLookupTool = tool({
    name: "repository_structure_lookup",
    description:
      "Explore the authorized branch's stored Git-tracked file paths. Use overview, directory listing, nested tree, or filename/path search as useful.",
    parameters: z.object({
      mode: z.enum(["overview", "list_directory", "tree", "search"]),
      path: z.string().optional(),
      query: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      depth: z.number().int().positive().optional(),
    }).strict(),
    strict: true,
    execute: async ({ mode, path, query, offset, limit, depth }) => {
      if (!repositoryStructureLookup) {
        throw new Error("Repository structure lookup is not configured.");
      }
      return repositoryStructureLookup(branchIndexId, {
        mode,
        path,
        query,
        offset,
        limit: Math.min(limit ?? 50, 100),
        depth: Math.min(depth ?? 2, 5),
      });
    },
  });

  const provider = new OpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    useResponses: false,
  });
  const agent = new Agent({
    name: "RepoLens retrieval agent",
    instructions: [
      "You are a retrieval agent, not an answer generator.",
      "Search only for code evidence needed to answer the user's question.",
      "Chunk embeddings contain source code together with available contextual metadata, which may include file paths, class names, symbol names, and symbol types.",
      "Repository structure contains all Git-tracked file paths, but does not guarantee that file contents are indexed or available through code retrieval.",
      "A file appearing in repository structure does not mean its contents have been retrieved. Use existing retrieval tools and searchCode metadata filters such as filePath to retrieve indexed chunks when useful.",
      "Decide independently whether repository structure is useful and which directories or files to explore; do not follow a fixed exploration sequence.",
      "If repository_structure_lookup reports that structure is unavailable, continue with existing retrieval tools. Do not assume the repository is empty or repeatedly retry the lookup.",
      "Use vector_search for semantic or conceptual questions.",
      "Use searchCode with mode='full_text' for natural-language terms, phrases, comments, error messages, file names, symbols or signatures.",
      "Use searchCode with mode='identifier' for a specific camelCase, PascalCase, snake_case or $-prefixed code identifier.",
      "Apply searchCode filters only for file, class, symbol, symbol type or language values explicitly identified in the question or supported by earlier evidence.",
      "When a file, class, or symbol is known, include it in vector_search text and use searchCode metadata filters when exactness is needed.",
      "Never invent file paths, class names, or symbol names; use only identifiers provided by the user or supported by retrieved evidence.",
      "Combine vector_search and searchCode when one retrieval method is insufficient.",
      "A search result's remainingSearches field is authoritative. Stop if it reaches zero or if context limits are reached.",
      "If the search returns no new useful chunks, stop rather than repeating the same evidence.",
      "When enough evidence has been gathered, return sufficient. Otherwise return insufficient.",
      "Never create the final user-facing answer or cite sources yourself.",
    ].join("\n"),
    model: await provider.getModel(config.model),
    tools: [vectorSearch, searchCodeTool, repositoryStructureLookupTool],
    outputType: retrievalOutcomeSchema,
  });

  let status: RetrievalOutcome<TChunk>["status"] = "insufficient";
  try {
    const result = await runAgent(agent, `Original user question: ${question}`, {
      maxTurns: budget.maxAgentTurns,
    });
    const parsed = retrievalOutcomeSchema.safeParse(result.finalOutput);
    if (parsed.success) status = parsed.data.status;
  } catch {
    status = "insufficient";
  } finally {
    await provider.close();
  }

  return { status, chunks: state.chunks, searchCalls: state.calls };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
