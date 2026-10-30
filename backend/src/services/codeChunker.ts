import { Parser, Language } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { ingestionLimits } from "../config/ingestionLimits.js";

export interface CodeChunk {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  symbolName: string | null;
  commitSha: string;
}

export interface ChunkerConfig {
  maxChunkChars?: number;
  minChunkChars?: number;
  chunkOverlapLines?: number;
}

const EXTENSION_TO_GRAMMAR: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".html": "html",
  ".css": "css",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
};

let parserInitialized = false;
let globalParser: Parser | null = null;
const loadedLanguages = new Map<string, Language>();

export async function getTreeSitterParser(
  grammarName: string,
): Promise<{ parser: Parser; language: Language } | null> {
  try {
    if (!parserInitialized) {
      await Parser.init();
      parserInitialized = true;
    }

    if (!globalParser) {
      globalParser = new Parser();
    }

    let language = loadedLanguages.get(grammarName);
    if (!language) {
      const wasmPath = getWasmPath(
        grammarName as Parameters<typeof getWasmPath>[0],
      );
      language = await Language.load(wasmPath);
      loadedLanguages.set(grammarName, language);
    }

    globalParser.setLanguage(language);
    return { parser: globalParser, language };
  } catch {
    // If grammar is not available or fails to load, caller falls back
    return null;
  }
}

export function isBinaryContent(content: string): boolean {
  if (content.includes("\0")) return true;

  const sample = content.slice(0, 1024);
  if (sample.length === 0) return false;

  let controlChars = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 65533
    ) {
      controlChars++;
    }
  }
  return controlChars / sample.length > 0.1;
}

export function detectLanguage(filePath: string): {
  language: string;
  grammar: string | null;
} {
  const dotIndex = filePath.lastIndexOf(".");
  const ext = dotIndex !== -1 ? filePath.slice(dotIndex).toLowerCase() : "";
  const grammar = EXTENSION_TO_GRAMMAR[ext] ?? null;

  const extToLangName: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".md": "markdown",
    ".sql": "sql",
    ".sh": "bash",
    ".xml": "xml",
    ".vue": "vue",
    ".kt": "kotlin",
    ".scala": "scala",
    ".swift": "swift",
    ".txt": "text",
  };

  const language = extToLangName[ext] ?? (ext ? ext.slice(1) : "text");
  return { language, grammar };
}

export async function chunkSourceFile(
  filePath: string,
  content: string,
  commitSha: string,
  config: ChunkerConfig = {},
): Promise<CodeChunk[]> {
  if (!content || !content.trim()) return [];
  if (isBinaryContent(content)) return [];

  const maxChars = config.maxChunkChars ?? ingestionLimits.maxChunkChars;
  const minChars = config.minChunkChars ?? ingestionLimits.minChunkChars;
  const { language, grammar } = detectLanguage(filePath);

  if (grammar) {
    const parserSetup = await getTreeSitterParser(grammar);
    if (parserSetup) {
      try {
        const tree = parserSetup.parser.parse(content);
        if (tree && tree.rootNode && tree.rootNode.childCount > 0) {
          const chunks = chunkWithTreeSitter(
            tree.rootNode as unknown as AstNode,
            content,
            filePath,
            language,
            commitSha,
            maxChars,
            minChars,
          );
          if (chunks.length > 0) {
            return deduplicateAndValidateChunks(chunks);
          }
        }
      } catch {
        // Fall back to line chunking if tree-sitter parsing fails
      }
    }
  }

  // Fallback: bounded line-based chunking
  const fallbackChunks = chunkByLines(
    filePath,
    content,
    language,
    commitSha,
    maxChars,
    config.chunkOverlapLines ?? ingestionLimits.chunkOverlapLines,
  );
  return deduplicateAndValidateChunks(fallbackChunks);
}

interface AstNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: AstNode[];
  childForFieldName?: (name: string) => AstNode | null;
}

const CONTAINER_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "struct_item",
  "impl_item",
  "trait_item",
  "enum_declaration",
]);

const FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "function_item",
  "arrow_function",
  "constructor_declaration",
]);

function extractSymbolName(node: AstNode): string | null {
  if (
    node.type === "export_statement" ||
    node.type === "decorated_definition"
  ) {
    for (const child of node.children) {
      const name = extractSymbolName(child);
      if (name) return name;
    }
  }

  if (typeof node.childForFieldName === "function") {
    const nameNode = node.childForFieldName("name");
    if (nameNode && nameNode.text) return nameNode.text;
  }

  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier"
    ) {
      return child.text;
    }
  }

  return null;
}

function chunkWithTreeSitter(
  root: AstNode,
  sourceCode: string,
  filePath: string,
  language: string,
  commitSha: string,
  maxChars: number,
  minChars: number,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const lines = sourceCode.split("\n");

  let smallUnitNodes: AstNode[] = [];
  let smallUnitCharCount = 0;

  function flushSmallUnits(): void {
    if (smallUnitNodes.length === 0) return;

    const firstNode = smallUnitNodes[0];
    const lastNode = smallUnitNodes[smallUnitNodes.length - 1];

    const startLine = firstNode.startPosition.row + 1;
    const endLine = lastNode.endPosition.row + 1;

    const sliceLines = lines.slice(startLine - 1, endLine);
    const text = sliceLines.join("\n").trim();

    if (text) {
      chunks.push({
        filePath,
        content: text,
        startLine,
        endLine,
        language,
        symbolName:
          smallUnitNodes.length === 1 ? extractSymbolName(firstNode) : null,
        commitSha,
      });
    }

    smallUnitNodes = [];
    smallUnitCharCount = 0;
  }

  function processTopLevelNode(node: AstNode): void {
    const nodeText = node.text.trim();
    if (!nodeText) return;

    let targetNode = node;
    if (
      node.type === "export_statement" ||
      node.type === "decorated_definition"
    ) {
      const declChild = node.children.find(
        (c) => CONTAINER_TYPES.has(c.type) || FUNCTION_TYPES.has(c.type),
      );
      if (declChild) {
        targetNode = declChild;
      }
    }

    const isContainer = CONTAINER_TYPES.has(targetNode.type);
    const isFunction = FUNCTION_TYPES.has(targetNode.type);
    const isSubstantive = isContainer || isFunction;

    // Small unit bundling
    if (!isSubstantive && nodeText.length < minChars) {
      if (smallUnitCharCount + nodeText.length > maxChars) {
        flushSmallUnits();
      }
      smallUnitNodes.push(node);
      smallUnitCharCount += nodeText.length;
      return;
    }

    // Node fits within chunk limit
    if (nodeText.length <= maxChars) {
      flushSmallUnits();
      chunks.push({
        filePath,
        content: nodeText,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        language,
        symbolName: extractSymbolName(targetNode),
        commitSha,
      });
      return;
    }

    // Oversized container (class, interface, struct): split into structural units
    if (isContainer) {
      flushSmallUnits();
      chunkOversizedContainer(
        node,
        targetNode,
        sourceCode,
        filePath,
        language,
        commitSha,
        maxChars,
        chunks,
      );
      return;
    }

    // Oversized function: split at syntax boundaries
    if (isFunction) {
      flushSmallUnits();
      chunkOversizedFunction(
        node,
        targetNode,
        sourceCode,
        filePath,
        language,
        commitSha,
        maxChars,
        chunks,
      );
      return;
    }

    // Other oversized top-level node: split by bounded lines
    flushSmallUnits();
    const nodeLines = chunkTextByLines(
      nodeText,
      node.startPosition.row + 1,
      filePath,
      language,
      commitSha,
      maxChars,
      extractSymbolName(targetNode),
    );
    chunks.push(...nodeLines);
  }

  for (const child of root.children) {
    processTopLevelNode(child);
  }

  flushSmallUnits();
  return chunks;
}

function chunkOversizedContainer(
  containerNode: AstNode,
  targetContainer: AstNode,
  sourceCode: string,
  filePath: string,
  language: string,
  commitSha: string,
  maxChars: number,
  outputChunks: CodeChunk[],
): void {
  const containerName = extractSymbolName(targetContainer) ?? "Anonymous";
  const bodyNode =
    targetContainer.children.find(
      (c) =>
        c.type.includes("body") ||
        c.type.includes("declaration_list") ||
        c.type.includes("block"),
    ) ?? targetContainer;

  // Header chunk (opening class definition before body contents)
  const headerStartLine = containerNode.startPosition.row + 1;
  const headerEndLine = bodyNode.startPosition.row + 1;
  const allLines = sourceCode.split("\n");
  const headerText = allLines
    .slice(headerStartLine - 1, headerEndLine)
    .join("\n")
    .trim();

  if (headerText && headerText.length <= maxChars) {
    outputChunks.push({
      filePath,
      content: headerText,
      startLine: headerStartLine,
      endLine: headerEndLine,
      language,
      symbolName: `${containerName} (declaration)`,
      commitSha,
    });
  }

  // Iterate structural members in container body
  for (const member of bodyNode.children) {
    const memberText = member.text.trim();
    if (!memberText || memberText === "{" || memberText === "}") continue;

    const memberName = extractSymbolName(member);
    const qualifiedName = memberName
      ? `${containerName}.${memberName}`
      : `${containerName} member`;

    if (memberText.length <= maxChars) {
      outputChunks.push({
        filePath,
        content: memberText,
        startLine: member.startPosition.row + 1,
        endLine: member.endPosition.row + 1,
        language,
        symbolName: qualifiedName,
        commitSha,
      });
    } else if (FUNCTION_TYPES.has(member.type)) {
      chunkOversizedFunction(
        member,
        member,
        sourceCode,
        filePath,
        language,
        commitSha,
        maxChars,
        outputChunks,
        qualifiedName,
      );
    } else {
      const memberChunks = chunkTextByLines(
        memberText,
        member.startPosition.row + 1,
        filePath,
        language,
        commitSha,
        maxChars,
        qualifiedName,
      );
      outputChunks.push(...memberChunks);
    }
  }
}

function chunkOversizedFunction(
  fnNode: AstNode,
  targetFn: AstNode,
  sourceCode: string,
  filePath: string,
  language: string,
  commitSha: string,
  maxChars: number,
  outputChunks: CodeChunk[],
  overrideName?: string,
): void {
  const fnName = overrideName ?? extractSymbolName(targetFn) ?? "function";
  const bodyNode = targetFn.children.find(
    (c) => c.type.includes("body") || c.type.includes("block"),
  );

  // If there is no discernible body node, chunk by lines
  if (!bodyNode || bodyNode.children.length === 0) {
    const chunks = chunkTextByLines(
      fnNode.text.trim(),
      fnNode.startPosition.row + 1,
      filePath,
      language,
      commitSha,
      maxChars,
      fnName,
    );
    outputChunks.push(...chunks);
    return;
  }

  // Statement-level chunking inside function body
  let currentStatements: AstNode[] = [];
  let currentCharCount = 0;
  let partNumber = 1;

  function flushStatements(): void {
    if (currentStatements.length === 0) return;

    const first = currentStatements[0];
    const last = currentStatements[currentStatements.length - 1];
    const allLines = sourceCode.split("\n");
    const startLine = first.startPosition.row + 1;
    const endLine = last.endPosition.row + 1;
    const text = allLines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim();

    if (text) {
      outputChunks.push({
        filePath,
        content: text,
        startLine,
        endLine,
        language,
        symbolName: `${fnName} (part ${partNumber++})`,
        commitSha,
      });
    }

    currentStatements = [];
    currentCharCount = 0;
  }

  for (const stmt of bodyNode.children) {
    const stmtText = stmt.text.trim();
    if (!stmtText || stmtText === "{" || stmtText === "}") continue;

    if (stmtText.length > maxChars) {
      flushStatements();
      const subChunks = chunkTextByLines(
        stmtText,
        stmt.startPosition.row + 1,
        filePath,
        language,
        commitSha,
        maxChars,
        `${fnName} (part ${partNumber++})`,
      );
      outputChunks.push(...subChunks);
    } else if (currentCharCount + stmtText.length > maxChars) {
      flushStatements();
      currentStatements.push(stmt);
      currentCharCount = stmtText.length;
    } else {
      currentStatements.push(stmt);
      currentCharCount += stmtText.length;
    }
  }

  flushStatements();
}

function chunkTextByLines(
  text: string,
  baseLine: number,
  filePath: string,
  language: string,
  commitSha: string,
  maxChars: number,
  symbolName: string | null,
): CodeChunk[] {
  const lines = text.split("\n");
  const chunks: CodeChunk[] = [];

  let startIdx = 0;
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1;
    if (currentChars + lineLen > maxChars && i > startIdx) {
      const slice = lines.slice(startIdx, i).join("\n").trim();
      if (slice) {
        chunks.push({
          filePath,
          content: slice,
          startLine: baseLine + startIdx,
          endLine: baseLine + i - 1,
          language,
          symbolName,
          commitSha,
        });
      }
      startIdx = i;
      currentChars = lineLen;
    } else {
      currentChars += lineLen;
    }
  }

  if (startIdx < lines.length) {
    const slice = lines.slice(startIdx).join("\n").trim();
    if (slice) {
      chunks.push({
        filePath,
        content: slice,
        startLine: baseLine + startIdx,
        endLine: baseLine + lines.length - 1,
        language,
        symbolName,
        commitSha,
      });
    }
  }

  return chunks;
}

export function chunkByLines(
  filePath: string,
  content: string,
  language: string,
  commitSha: string,
  maxChars: number,
  overlapLines: number = 0,
): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];

  let startIdx = 0;
  while (startIdx < lines.length) {
    let endIdx = startIdx;
    let chars = 0;

    while (endIdx < lines.length) {
      const lineLen = lines[endIdx].length + 1;
      if (chars + lineLen > maxChars && endIdx > startIdx) {
        break;
      }
      chars += lineLen;
      endIdx++;
    }

    const chunkContent = lines.slice(startIdx, endIdx).join("\n").trim();
    if (chunkContent) {
      chunks.push({
        filePath,
        content: chunkContent,
        startLine: startIdx + 1,
        endLine: endIdx,
        language,
        symbolName: null,
        commitSha,
      });
    }

    if (endIdx >= lines.length) break;

    // Advance with optional overlap, ensuring forward progress
    const step = Math.max(1, endIdx - startIdx - overlapLines);
    startIdx += step;
  }

  return chunks;
}

function deduplicateAndValidateChunks(chunks: CodeChunk[]): CodeChunk[] {
  const seen = new Set<string>();
  const validated: CodeChunk[] = [];

  for (const chunk of chunks) {
    if (!chunk.content || !chunk.content.trim()) continue;
    if (chunk.startLine > chunk.endLine) continue;

    const key = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}:${chunk.content.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    validated.push(chunk);
  }

  return validated;
}
