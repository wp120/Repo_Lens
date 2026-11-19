import { Agent, OpenAIProvider, run, tool } from "@openai/agents";
import { z } from "zod";
import type { RetrievedChunk } from "./conversationFlow.js";

export interface RetrievalBudget {
  maxSearchCalls: number;
  maxChunksPerSearch: number;
  maxUniqueChunks: number;
  maxContextTokens: number;
  maxAgentTurns: number;
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
  chunks: TChunk[];
  chunkIds: Set<string>;
  contextTokens: number;
}

export const defaultRetrievalBudget: RetrievalBudget = {
  maxSearchCalls: 4,
  maxChunksPerSearch: 10,
  maxUniqueChunks: 25,
  maxContextTokens: 12000,
  maxAgentTurns: 12,
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
    if (seen.has(id)) continue;
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
  search: (branchIndexId: string, query: string, limit: number) => Promise<TChunk[]>,
  runAgent: typeof run = run,
): Promise<RetrievalOutcome<TChunk>> {
  const budget = getRetrievalBudget(config.budget);
  const state: RetrievalRunState<TChunk> = {
    calls: 0,
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
      const found = await search(branchIndexId, query.trim(), cappedLimit);
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
      "When the user's question mentions a file, class, or symbol, include that known information in the relevant vector_search query.",
      "Never invent file paths, class names, or symbol names; use only identifiers provided by the user or supported by retrieved evidence.",
      "Use vector_search, evaluating each result before deciding whether another search is needed.",
      "A search result's remainingSearches field is authoritative. Stop if it reaches zero or if context limits are reached.",
      "If the search returns no new useful chunks, stop rather than repeating the same evidence.",
      "When enough evidence has been gathered, return sufficient. Otherwise return insufficient.",
      "Never create the final user-facing answer or cite sources yourself.",
    ].join("\n"),
    model: await provider.getModel(config.model),
    tools: [vectorSearch],
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
