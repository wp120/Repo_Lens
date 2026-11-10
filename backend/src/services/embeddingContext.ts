import type { CodeChunk } from "./codeChunker.js";

export function buildChunkEmbeddingText(chunk: CodeChunk): string {
  const context = [`File: ${chunk.filePath}`, `Language: ${chunk.language}`];
  addOptionalMetadata(context, "Class", chunk.className);
  addOptionalMetadata(context, "Symbol", chunk.symbolName);
  addOptionalMetadata(context, "Symbol type", chunk.symbolType);
  addOptionalMetadata(context, "Signature", chunk.functionSignature);

  return `${context.join("\n")}\n\nCode:\n${chunk.content}`;
}

function addOptionalMetadata(
  context: string[],
  label: string,
  value: string | null | undefined,
): void {
  const metadata = value?.trim();
  if (metadata) context.push(`${label}: ${metadata}`);
}
