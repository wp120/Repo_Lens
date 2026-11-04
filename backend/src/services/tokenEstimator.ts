/**
 * Conservative character-based token estimate shared by chunking and embedding.
 * This intentionally stays approximate; Voyage enforces the final request limit.
 */
export function estimateVoyageTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
