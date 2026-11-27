import { Parser, Language } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { ingestionLimits } from "../config/ingestionLimits.js";
import { estimateVoyageTokens } from "./tokenEstimator.js";
import {
  extractGraphFromAst,
  isGraphExtractionSupported,
  type ExtractedSymbol,
  type ExtractedRelationshipCandidate,
} from "./codeGraphExtractor.js";

export interface FileParseResult {
  chunks: CodeChunk[];
  symbols: ExtractedSymbol[];
  relationshipCandidates: ExtractedRelationshipCandidate[];
}

export interface CodeChunk {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  symbolName: string | null;
  symbolType?: string | null;
  className?: string | null;
  functionSignature?: string | null;
  commitSha: string;
}

export interface ChunkerConfig {
  maxChunkChars?: number;
  maxTokensPerChunk?: number;
  minChunkChars?: number;
  targetChunkChars?: number;
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

export async function parseSourceFileWithGraph(
  filePath: string,
  content: string,
  commitSha: string,
  config: ChunkerConfig = {},
): Promise<FileParseResult> {
  if (!content || !content.trim()) {
    return { chunks: [], symbols: [], relationshipCandidates: [] };
  }
  if (isBinaryContent(content)) {
    return { chunks: [], symbols: [], relationshipCandidates: [] };
  }

  const maxChars = config.maxChunkChars ?? ingestionLimits.maxChunkChars;
  const maxTokens =
    config.maxTokensPerChunk ?? ingestionLimits.maxTokensPerChunk;
  const minChars = config.minChunkChars ?? ingestionLimits.minChunkChars;
  const { language, grammar } = detectLanguage(filePath);

  let symbols: ExtractedSymbol[] = [];
  let relationshipCandidates: ExtractedRelationshipCandidate[] = [];

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
            maxTokens,
            config.targetChunkChars ?? ingestionLimits.targetChunkChars,
          );

          if (isGraphExtractionSupported(language)) {
            const graphData = extractGraphFromAst(
              tree.rootNode as unknown as AstNode,
              content,
              filePath,
              language,
            );
            symbols = graphData.symbols;
            relationshipCandidates = graphData.relationshipCandidates;
          }

          if (chunks.length > 0) {
            return {
              chunks: deduplicateAndValidateChunks(chunks),
              symbols,
              relationshipCandidates,
            };
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
    maxTokens,
  );
  return {
    chunks: deduplicateAndValidateChunks(fallbackChunks),
    symbols,
    relationshipCandidates,
  };
}

export async function chunkSourceFile(
  filePath: string,
  content: string,
  commitSha: string,
  config: ChunkerConfig = {},
): Promise<CodeChunk[]> {
  const result = await parseSourceFileWithGraph(
    filePath,
    content,
    commitSha,
    config,
  );
  return result.chunks;
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

function extractFunctionSignature(node: AstNode): string | null {
  const firstLine = node.text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return null;

  const bodyIndex = firstLine.search(/\{\s*$/);
  const colonIndex = firstLine.endsWith(":") ? firstLine.length - 1 : -1;
  const endIndex =
    bodyIndex >= 0 ? bodyIndex : colonIndex >= 0 ? colonIndex : -1;
  const signature = (
    endIndex >= 0 ? firstLine.slice(0, endIndex) : firstLine
  ).trim();
  return signature || null;
}

function extractClassOverview(
  containerName: string,
  containerNode: AstNode,
  bodyNode: AstNode,
): string {
  const declaration =
    containerNode.text.split("\n")[0]?.trim() ?? containerName;
  const lines = [declaration];
  for (const member of bodyNode.children) {
    const name = extractSymbolName(member);
    if (!name) continue;
    if (FUNCTION_TYPES.has(member.type)) {
      const signature = extractFunctionSignature(member);
      lines.push(signature ?? `${name}(...)`);
    } else if (
      member.type.includes("field") ||
      member.type.includes("property") ||
      member.type.includes("member")
    ) {
      lines.push(member.text.split("\n")[0]?.trim() ?? name);
    }
  }
  return lines.join("\n");
}

function chunkWithTreeSitter(
  root: AstNode,
  sourceCode: string,
  filePath: string,
  language: string,
  commitSha: string,
  maxChars: number,
  minChars: number,
  maxTokens: number,
  targetChars: number,
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
      const bundledText = [...smallUnitNodes, node]
        .map((unit) => unit.text.trim())
        .join("\n");
      if (estimateVoyageTokens(bundledText) > maxTokens) {
        flushSmallUnits();
        const split = chunkTextByLines(
          nodeText,
          node.startPosition.row + 1,
          filePath,
          language,
          commitSha,
          maxChars,
          extractSymbolName(targetNode),
          maxTokens,
        );
        chunks.push(...split);
        return;
      }
      smallUnitNodes.push(node);
      smallUnitCharCount += nodeText.length;
      return;
    }

    // Node fits within chunk limit
    if (nodeFitsBudgets(nodeText, maxChars, maxTokens)) {
      flushSmallUnits();
      chunks.push({
        filePath,
        content: nodeText,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        language,
        symbolName: extractSymbolName(targetNode),
        symbolType: isContainer
          ? "class"
          : isFunction
            ? "function"
            : "statement",
        className: isContainer ? extractSymbolName(targetNode) : null,
        functionSignature: isFunction
          ? extractFunctionSignature(targetNode)
          : null,
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
        maxTokens,
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
        maxTokens,
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
      maxTokens,
    );
    chunks.push(...nodeLines);
  }

  for (const child of root.children) {
    processTopLevelNode(child);
  }

  flushSmallUnits();
  const validatedChunks: CodeChunk[] = [];
  for (const chunk of chunks) {
    if (nodeFitsBudgets(chunk.content, maxChars, maxTokens)) {
      validatedChunks.push(chunk);
      continue;
    }
    for (const part of splitOversizedText(
      chunk.content,
      chunk.startLine,
      maxChars,
      maxTokens,
    )) {
      validatedChunks.push({
        ...chunk,
        content: part.content,
        startLine: part.startLine,
        endLine: part.endLine,
      });
    }
  }
  const merged = mergeTrailingSmallUnits(
    validatedChunks,
    minChars,
    maxChars,
    maxTokens,
  );
  return merged;
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
  maxTokens: number,
): void {
  const containerName = extractSymbolName(targetContainer) ?? "Anonymous";
  const bodyNode =
    targetContainer.children.find(
      (c) =>
        c.type.includes("body") ||
        c.type.includes("declaration_list") ||
        c.type.includes("block"),
    ) ?? targetContainer;

  // Add a small source-grounded structural overview for oversized containers.
  const headerStartLine = containerNode.startPosition.row + 1;
  const headerEndLine = bodyNode.startPosition.row + 1;
  const overviewText = extractClassOverview(
    containerName,
    containerNode,
    bodyNode,
  );
  if (overviewText && nodeFitsBudgets(overviewText, maxChars, maxTokens)) {
    outputChunks.push({
      filePath,
      content: overviewText,
      startLine: headerStartLine,
      endLine: headerEndLine,
      language,
      symbolName: `${containerName} (declaration)`,
      symbolType: "class_overview",
      className: containerName,
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

    if (nodeFitsBudgets(memberText, maxChars, maxTokens)) {
      outputChunks.push({
        filePath,
        content: memberText,
        startLine: member.startPosition.row + 1,
        endLine: member.endPosition.row + 1,
        language,
        symbolName: qualifiedName,
        symbolType: FUNCTION_TYPES.has(member.type) ? "method" : "class_member",
        className: containerName,
        functionSignature: FUNCTION_TYPES.has(member.type)
          ? extractFunctionSignature(member)
          : null,
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
        maxTokens,
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
        maxTokens,
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
  maxTokens: number,
  overrideName?: string,
): void {
  const fnName = overrideName ?? extractSymbolName(targetFn) ?? "function";
  const className = overrideName?.includes(".")
    ? overrideName.slice(0, overrideName.lastIndexOf("."))
    : null;
  const functionSignature = extractFunctionSignature(targetFn);
  const annotate = (chunks: CodeChunk[]): CodeChunk[] =>
    chunks.map((chunk) => ({
      ...chunk,
      symbolType: className ? "method" : "function",
      className,
      functionSignature,
    }));
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
      maxTokens,
    );
    outputChunks.push(...annotate(chunks));
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
        symbolType: className ? "method" : "function",
        className,
        functionSignature,
        commitSha,
      });
    }

    currentStatements = [];
    currentCharCount = 0;
  }

  for (const stmt of bodyNode.children) {
    const stmtText = stmt.text.trim();
    if (!stmtText || stmtText === "{" || stmtText === "}") continue;

    if (!nodeFitsBudgets(stmtText, maxChars, maxTokens)) {
      flushStatements();
      const nestedStatements = findNestedStatements(stmt);
      const subChunks =
        nestedStatements.length > 0
          ? chunkStatementsAtBudgets(
              nestedStatements,
              sourceCode,
              filePath,
              language,
              commitSha,
              maxChars,
              maxTokens,
              `${fnName} (part ${partNumber++})`,
            )
          : chunkTextByLines(
              stmtText,
              stmt.startPosition.row + 1,
              filePath,
              language,
              commitSha,
              maxChars,
              `${fnName} (part ${partNumber++})`,
              maxTokens,
            );
      outputChunks.push(...annotate(subChunks));
    } else if (
      currentCharCount + stmtText.length > maxChars ||
      !nodeFitsBudgets(
        sourceTextForNodes(currentStatements.concat(stmt), sourceCode),
        maxChars,
        maxTokens,
      )
    ) {
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
  maxTokens: number,
): CodeChunk[] {
  const lines = text.split("\n");
  const chunks: CodeChunk[] = [];
  const maxSliceChars = Math.min(maxChars, maxTokens * 4);

  let startIdx = 0;
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1;
    if (
      (currentChars + lineLen > maxSliceChars ||
        estimateVoyageTokens(lines.slice(startIdx, i + 1).join("\n")) >
          maxTokens) &&
      i > startIdx
    ) {
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

  const tokenSafeChunks: CodeChunk[] = [];
  for (const chunk of chunks) {
    if (nodeFitsBudgets(chunk.content, maxChars, maxTokens)) {
      tokenSafeChunks.push(chunk);
      continue;
    }

    const split = splitOversizedText(
      chunk.content,
      chunk.startLine,
      maxSliceChars,
      maxTokens,
    );
    for (const part of split) {
      tokenSafeChunks.push({
        ...chunk,
        content: part.content,
        startLine: part.startLine,
        endLine: part.endLine,
      });
    }
  }

  return tokenSafeChunks;
}

function nodeFitsBudgets(
  text: string,
  maxChars: number,
  maxTokens: number,
): boolean {
  return text.length <= maxChars && estimateVoyageTokens(text) <= maxTokens;
}

function sourceTextForNodes(nodes: AstNode[], sourceCode: string): string {
  if (nodes.length === 0) return "";
  const lines = sourceCode.split("\n");
  const startLine = nodes[0].startPosition.row;
  const endLine = nodes[nodes.length - 1].endPosition.row + 1;
  return lines.slice(startLine, endLine).join("\n").trim();
}

function findNestedStatements(node: AstNode): AstNode[] {
  const nestedBodies = node.children.filter(
    (child) =>
      child.type.includes("block") ||
      child.type.includes("body") ||
      child.type.includes("suite"),
  );

  for (const body of nestedBodies) {
    const statements = body.children.filter(
      (child) =>
        child.text.trim() !== "" &&
        child.text.trim() !== "{" &&
        child.text.trim() !== "}",
    );
    if (statements.length > 1) return statements;
  }

  return [];
}

function chunkStatementsAtBudgets(
  statements: AstNode[],
  sourceCode: string,
  filePath: string,
  language: string,
  commitSha: string,
  maxChars: number,
  maxTokens: number,
  symbolName: string,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let group: AstNode[] = [];

  const flush = (): void => {
    if (group.length === 0) return;
    const text = sourceTextForNodes(group, sourceCode);
    if (text) {
      chunks.push({
        filePath,
        content: text,
        startLine: group[0].startPosition.row + 1,
        endLine: group[group.length - 1].endPosition.row + 1,
        language,
        symbolName,
        commitSha,
      });
    }
    group = [];
  };

  for (const statement of statements) {
    const text = statement.text.trim();
    if (!nodeFitsBudgets(text, maxChars, maxTokens)) {
      flush();
      const nested = findNestedStatements(statement);
      if (nested.length > 0) {
        chunks.push(
          ...chunkStatementsAtBudgets(
            nested,
            sourceCode,
            filePath,
            language,
            commitSha,
            maxChars,
            maxTokens,
            symbolName,
          ),
        );
      } else {
        chunks.push(
          ...chunkTextByLines(
            text,
            statement.startPosition.row + 1,
            filePath,
            language,
            commitSha,
            maxChars,
            symbolName,
            maxTokens,
          ),
        );
      }
      continue;
    }

    const candidate = sourceTextForNodes([...group, statement], sourceCode);
    if (group.length > 0 && !nodeFitsBudgets(candidate, maxChars, maxTokens)) {
      flush();
    }
    group.push(statement);
  }
  flush();
  return chunks;
}

interface SplitTextPart {
  content: string;
  startLine: number;
  endLine: number;
}

function splitOversizedText(
  text: string,
  baseLine: number,
  maxChars: number,
  maxTokens: number,
): SplitTextPart[] {
  const parts: SplitTextPart[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(text.length, offset + Math.min(maxChars, maxTokens * 4));
    if (end < text.length) {
      const window = text.slice(offset, end);
      const whitespace = Math.max(
        window.lastIndexOf(" "),
        window.lastIndexOf("\t"),
      );
      if (whitespace >= Math.floor(window.length / 2)) {
        end = offset + whitespace + 1;
      }
    }
    if (end <= offset) end = offset + 1;

    const partText = text.slice(offset, end);
    const prefix = text.slice(0, offset);
    const partPrefixLines = partText.includes("\n")
      ? partText.slice(0, partText.lastIndexOf("\n")).split("\n").length
      : 0;
    parts.push({
      content: partText,
      startLine: baseLine + prefix.split("\n").length - 1,
      endLine: baseLine + prefix.split("\n").length - 1 + partPrefixLines,
    });
    offset = end;
  }

  return parts;
}

export function chunkByLines(
  filePath: string,
  content: string,
  language: string,
  commitSha: string,
  maxChars: number,
  overlapLines: number = 0,
  maxTokens: number = ingestionLimits.maxTokensPerChunk,
): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];

  let startIdx = 0;
  while (startIdx < lines.length) {
    let endIdx = startIdx;
    let chars = 0;

    while (endIdx < lines.length) {
      const lineLen = lines[endIdx].length + 1;
      if (
        (chars + lineLen > maxChars ||
          estimateVoyageTokens(lines.slice(startIdx, endIdx + 1).join("\n")) >
            maxTokens) &&
        endIdx > startIdx
      ) {
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

  const validatedChunks: CodeChunk[] = [];
  for (const chunk of chunks) {
    if (nodeFitsBudgets(chunk.content, maxChars, maxTokens)) {
      validatedChunks.push(chunk);
      continue;
    }
    for (const part of splitOversizedText(
      chunk.content,
      chunk.startLine,
      maxChars,
      maxTokens,
    )) {
      validatedChunks.push({
        ...chunk,
        content: part.content,
        startLine: part.startLine,
        endLine: part.endLine,
      });
    }
  }
  return validatedChunks;
}

function deduplicateAndValidateChunks(chunks: CodeChunk[]): CodeChunk[] {
  const validated: CodeChunk[] = [];

  for (const chunk of chunks) {
    if (!chunk.content || !chunk.content.trim()) continue;
    if (chunk.startLine > chunk.endLine) continue;

    validated.push(chunk);
  }

  return validated;
}

function mergeTrailingSmallUnits(
  chunks: CodeChunk[],
  softMinimum: number,
  maxChars: number,
  maxTokens: number,
): CodeChunk[] {
  if (chunks.length < 2) return chunks;

  const last = chunks[chunks.length - 1];
  const preceding = chunks[chunks.length - 2];
  if (
    last.content.length >= softMinimum ||
    preceding.symbolName !== null ||
    last.symbolName !== null ||
    !last.filePath ||
    !preceding.filePath
  ) {
    return chunks;
  }

  const mergedContent = `${preceding.content.trim()}\n${last.content.trim()}`;
  if (!nodeFitsBudgets(mergedContent, maxChars, maxTokens)) return chunks;

  return [
    ...chunks.slice(0, -2),
    {
      ...preceding,
      content: mergedContent,
      endLine: last.endLine,
    },
  ];
}
