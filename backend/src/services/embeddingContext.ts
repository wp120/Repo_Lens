import type { CodeChunk } from "./codeChunker.js";

export function buildChunkEmbeddingInput(chunk: CodeChunk): string {
  const context: string[] = [
    `File: ${chunk.filePath}`,
    `Language: ${chunk.language}`,
  ];

  if (chunk.className) context.push(`Class: ${chunk.className}`);
  if (chunk.functionSignature) {
    context.push(`Function: ${chunk.symbolName ?? chunk.functionSignature}`);
    context.push(`Signature: ${chunk.functionSignature}`);
  } else if (chunk.symbolName) {
    context.push(`Symbol: ${chunk.symbolName}`);
  }

  return `${context.join("\n")}\n\n${chunk.content}`;
}
