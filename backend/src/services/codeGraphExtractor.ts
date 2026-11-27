export type GraphRelationshipType =
  "CALL" | "IMPORT" | "INHERITS" | "IMPLEMENTS";

export interface ExtractedSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface";
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  containerName?: string | null;
  signature?: string | null;
}

export interface ExtractedRelationshipCandidate {
  type: GraphRelationshipType;
  filePath: string;
  startLine: number;
  endLine: number;
  referenceName: string;
  targetModule?: string | null;
  fromSymbolName?: string | null;
  fromContainerName?: string | null;
  fromSymbolStartLine?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AstNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: AstNode[];
  childForFieldName?: (name: string) => AstNode | null;
}

export const SUPPORTED_GRAPH_LANGUAGES: Record<
  string,
  readonly GraphRelationshipType[]
> = {
  typescript: ["CALL", "IMPORT", "INHERITS", "IMPLEMENTS"],
  tsx: ["CALL", "IMPORT", "INHERITS", "IMPLEMENTS"],
  javascript: ["CALL", "IMPORT", "INHERITS"],
  python: ["CALL", "IMPORT", "INHERITS"],
};

export function isGraphExtractionSupported(language: string): boolean {
  return language in SUPPORTED_GRAPH_LANGUAGES;
}

function cleanStringLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface ExtractionContext {
  filePath: string;
  language: string;
  symbols: ExtractedSymbol[];
  candidates: ExtractedRelationshipCandidate[];
  currentContainer: string | null;
  currentFunction: { name: string; startLine: number } | null;
}

export function extractGraphFromAst(
  root: AstNode,
  sourceCode: string,
  filePath: string,
  language: string,
): {
  symbols: ExtractedSymbol[];
  relationshipCandidates: ExtractedRelationshipCandidate[];
} {
  const ctx: ExtractionContext = {
    filePath,
    language,
    symbols: [],
    candidates: [],
    currentContainer: null,
    currentFunction: null,
  };

  const normalizedLang = language.toLowerCase();
  if (
    normalizedLang === "typescript" ||
    normalizedLang === "tsx" ||
    normalizedLang === "javascript"
  ) {
    traverseJsTs(root, ctx);
  } else if (normalizedLang === "python") {
    traversePython(root, ctx);
  }

  return {
    symbols: ctx.symbols,
    relationshipCandidates: ctx.candidates,
  };
}

function traverseJsTs(node: AstNode, ctx: ExtractionContext): void {
  // 1. Imports
  if (node.type === "import_statement") {
    extractJsTsImport(node, ctx);
    return;
  }

  // 2. Interfaces
  if (node.type === "interface_declaration") {
    const nameNode =
      node.childForFieldName?.("name") ??
      node.children.find(
        (c) => c.type === "type_identifier" || c.type === "identifier",
      );
    if (nameNode) {
      ctx.symbols.push({
        name: nameNode.text,
        kind: "interface",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });
    }
  }

  // 3. Classes
  if (node.type === "class_declaration" || node.type === "class") {
    const nameNode =
      node.childForFieldName?.("name") ??
      node.children.find(
        (c) => c.type === "type_identifier" || c.type === "identifier",
      );
    const className = nameNode ? nameNode.text : "Anonymous";

    if (nameNode) {
      ctx.symbols.push({
        name: className,
        kind: "class",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });
    }

    // Heritage: extends and implements
    const heritageNode = node.children.find((c) => c.type === "class_heritage");
    if (heritageNode) {
      for (const hChild of heritageNode.children) {
        if (hChild.type === "extends_clause") {
          for (const extTarget of hChild.children) {
            if (
              extTarget.type === "identifier" ||
              extTarget.type === "type_identifier"
            ) {
              ctx.candidates.push({
                type: "INHERITS",
                filePath: ctx.filePath,
                startLine: hChild.startPosition.row + 1,
                endLine: hChild.endPosition.row + 1,
                referenceName: extTarget.text,
                fromSymbolName: className,
                fromContainerName: ctx.currentContainer,
              });
            }
          }
        } else if (hChild.type === "implements_clause") {
          for (const implTarget of hChild.children) {
            if (
              implTarget.type === "type_identifier" ||
              implTarget.type === "identifier"
            ) {
              ctx.candidates.push({
                type: "IMPLEMENTS",
                filePath: ctx.filePath,
                startLine: hChild.startPosition.row + 1,
                endLine: hChild.endPosition.row + 1,
                referenceName: implTarget.text,
                fromSymbolName: className,
                fromContainerName: ctx.currentContainer,
              });
            }
          }
        }
      }
    }

    // Traverse class body with container set
    const prevContainer = ctx.currentContainer;
    ctx.currentContainer = className;
    for (const child of node.children) {
      if (child.type === "class_body") {
        for (const member of child.children) {
          traverseJsTs(member, ctx);
        }
      }
    }
    ctx.currentContainer = prevContainer;
    return;
  }

  // 4. Methods
  if (
    node.type === "method_definition" ||
    node.type === "abstract_method_signature"
  ) {
    const nameNode =
      node.childForFieldName?.("name") ??
      node.children.find(
        (c) => c.type === "property_identifier" || c.type === "identifier",
      );
    if (nameNode) {
      const methodName = nameNode.text;
      const startLine = node.startPosition.row + 1;
      ctx.symbols.push({
        name: methodName,
        kind: "method",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });

      const prevFunction = ctx.currentFunction;
      ctx.currentFunction = { name: methodName, startLine };
      for (const child of node.children) {
        if (child.type === "statement_block" || child.type === "body") {
          traverseJsTs(child, ctx);
        }
      }
      ctx.currentFunction = prevFunction;
      return;
    }
  }

  // 5. Functions
  if (
    node.type === "function_declaration" ||
    node.type === "function_signature"
  ) {
    const nameNode =
      node.childForFieldName?.("name") ??
      node.children.find((c) => c.type === "identifier");
    if (nameNode) {
      const funcName = nameNode.text;
      const startLine = node.startPosition.row + 1;
      ctx.symbols.push({
        name: funcName,
        kind: "function",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });

      const prevFunction = ctx.currentFunction;
      ctx.currentFunction = { name: funcName, startLine };
      for (const child of node.children) {
        if (child.type === "statement_block" || child.type === "body") {
          traverseJsTs(child, ctx);
        }
      }
      ctx.currentFunction = prevFunction;
      return;
    }
  }

  // Variable declarator containing arrow function or function expression
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName?.("name");
    const valueNode = node.childForFieldName?.("value");
    if (
      nameNode &&
      nameNode.type === "identifier" &&
      valueNode &&
      (valueNode.type === "arrow_function" ||
        valueNode.type === "function_expression" ||
        valueNode.type === "function")
    ) {
      const funcName = nameNode.text;
      const startLine = node.startPosition.row + 1;
      ctx.symbols.push({
        name: funcName,
        kind: "function",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });

      const prevFunction = ctx.currentFunction;
      ctx.currentFunction = { name: funcName, startLine };
      traverseJsTs(valueNode, ctx);
      ctx.currentFunction = prevFunction;
      return;
    }
  }

  // 6. Function Calls
  if (node.type === "call_expression") {
    const fnNode = node.childForFieldName?.("function") ?? node.children[0];
    if (fnNode) {
      if (fnNode.type === "identifier") {
        ctx.candidates.push({
          type: "CALL",
          filePath: ctx.filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          referenceName: fnNode.text,
          fromSymbolName: ctx.currentFunction?.name ?? null,
          fromContainerName: ctx.currentContainer ?? null,
          fromSymbolStartLine: ctx.currentFunction?.startLine ?? null,
        });
      } else if (fnNode.type === "member_expression") {
        const propNode =
          fnNode.childForFieldName?.("property") ??
          fnNode.children.find((c) => c.type === "property_identifier");
        const objectNode =
          fnNode.childForFieldName?.("object") ?? fnNode.children[0];
        if (propNode) {
          ctx.candidates.push({
            type: "CALL",
            filePath: ctx.filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            referenceName: propNode.text,
            fromSymbolName: ctx.currentFunction?.name ?? null,
            fromContainerName: ctx.currentContainer ?? null,
            fromSymbolStartLine: ctx.currentFunction?.startLine ?? null,
            metadata: objectNode ? { receiver: objectNode.text } : null,
          });
        }
      }
    }
  }

  // Recurse children
  for (const child of node.children) {
    traverseJsTs(child, ctx);
  }
}

function extractJsTsImport(node: AstNode, ctx: ExtractionContext): void {
  const sourceNode =
    node.childForFieldName?.("source") ??
    node.children.find((c) => c.type === "string");
  if (!sourceNode) return;

  const targetModule = cleanStringLiteral(sourceNode.text);

  // Check import clause
  const importClause = node.children.find((c) => c.type === "import_clause");
  if (!importClause) return;

  for (const child of importClause.children) {
    // Default import: import Foo from './foo'
    if (child.type === "identifier") {
      ctx.candidates.push({
        type: "IMPORT",
        filePath: ctx.filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        referenceName: child.text,
        targetModule,
        metadata: {
          importedAs: child.text,
          originalName: "default",
          isDefault: true,
        },
      });
    }

    // Named imports: import { a, b as c } from './foo'
    if (child.type === "named_imports") {
      for (const spec of child.children) {
        if (spec.type === "import_specifier") {
          const nameNode = spec.childForFieldName?.("name") ?? spec.children[0];
          const aliasNode = spec.childForFieldName?.("alias");
          if (nameNode) {
            const originalName = nameNode.text;
            const importedAs = aliasNode ? aliasNode.text : originalName;
            ctx.candidates.push({
              type: "IMPORT",
              filePath: ctx.filePath,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              referenceName: originalName,
              targetModule,
              metadata: {
                importedAs,
                originalName,
                isDefault: false,
                alias: aliasNode ? aliasNode.text : null,
              },
            });
          }
        }
      }
    }

    // Namespace import: import * as foo from './foo'
    if (child.type === "namespace_import") {
      const aliasNode =
        child.childForFieldName?.("name") ??
        child.children.find((c) => c.type === "identifier");
      if (aliasNode) {
        ctx.candidates.push({
          type: "IMPORT",
          filePath: ctx.filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          referenceName: "*",
          targetModule,
          metadata: {
            importedAs: aliasNode.text,
            originalName: "*",
            isNamespace: true,
            alias: aliasNode.text,
          },
        });
      }
    }
  }
}

function traversePython(node: AstNode, ctx: ExtractionContext): void {
  // 1. Imports
  if (node.type === "import_statement") {
    extractPythonImport(node, ctx);
    return;
  }
  if (node.type === "import_from_statement") {
    extractPythonFromImport(node, ctx);
    return;
  }

  // 2. Class definition
  if (node.type === "class_definition") {
    const nameNode =
      node.childForFieldName?.("name") ??
      node.children.find((c) => c.type === "identifier");
    const className = nameNode ? nameNode.text : "Anonymous";

    if (nameNode) {
      ctx.symbols.push({
        name: className,
        kind: "class",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });
    }

    // Superclasses (argument_list in class_definition)
    const superclassesNode =
      node.childForFieldName?.("superclasses") ??
      node.children.find((c) => c.type === "argument_list");
    if (superclassesNode) {
      for (const sc of superclassesNode.children) {
        if (sc.type === "identifier") {
          ctx.candidates.push({
            type: "INHERITS",
            filePath: ctx.filePath,
            startLine: sc.startPosition.row + 1,
            endLine: sc.endPosition.row + 1,
            referenceName: sc.text,
            fromSymbolName: className,
            fromContainerName: ctx.currentContainer,
          });
        }
      }
    }

    // Recurse class body
    const prevContainer = ctx.currentContainer;
    ctx.currentContainer = className;
    const bodyNode =
      node.childForFieldName?.("body") ??
      node.children.find((c) => c.type === "block");
    if (bodyNode) {
      for (const child of bodyNode.children) {
        traversePython(child, ctx);
      }
    }
    ctx.currentContainer = prevContainer;
    return;
  }

  // 3. Function/Method definition
  if (node.type === "function_definition") {
    const nameNode =
      node.childForFieldName?.("name") ??
      node.children.find((c) => c.type === "identifier");
    if (nameNode) {
      const funcName = nameNode.text;
      const isMethod = ctx.currentContainer !== null;
      const startLine = node.startPosition.row + 1;
      ctx.symbols.push({
        name: funcName,
        kind: isMethod ? "method" : "function",
        language: ctx.language,
        filePath: ctx.filePath,
        startLine,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        containerName: ctx.currentContainer,
      });

      const prevFunction = ctx.currentFunction;
      ctx.currentFunction = { name: funcName, startLine };
      const bodyNode =
        node.childForFieldName?.("body") ??
        node.children.find((c) => c.type === "block");
      if (bodyNode) {
        for (const child of bodyNode.children) {
          traversePython(child, ctx);
        }
      }
      ctx.currentFunction = prevFunction;
      return;
    }
  }

  // 4. Calls
  if (node.type === "call") {
    const fnNode = node.childForFieldName?.("function") ?? node.children[0];
    if (fnNode) {
      if (fnNode.type === "identifier") {
        ctx.candidates.push({
          type: "CALL",
          filePath: ctx.filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          referenceName: fnNode.text,
          fromSymbolName: ctx.currentFunction?.name ?? null,
          fromContainerName: ctx.currentContainer ?? null,
          fromSymbolStartLine: ctx.currentFunction?.startLine ?? null,
        });
      } else if (fnNode.type === "attribute") {
        const attrNode =
          fnNode.childForFieldName?.("attribute") ??
          fnNode.children.find((c, idx) => idx > 0 && c.type === "identifier");
        const objectNode =
          fnNode.childForFieldName?.("object") ?? fnNode.children[0];
        if (attrNode) {
          ctx.candidates.push({
            type: "CALL",
            filePath: ctx.filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            referenceName: attrNode.text,
            fromSymbolName: ctx.currentFunction?.name ?? null,
            fromContainerName: ctx.currentContainer ?? null,
            fromSymbolStartLine: ctx.currentFunction?.startLine ?? null,
            metadata: objectNode ? { receiver: objectNode.text } : null,
          });
        }
      }
    }
  }

  for (const child of node.children) {
    traversePython(child, ctx);
  }
}

function extractPythonImport(node: AstNode, ctx: ExtractionContext): void {
  // e.g. import foo, bar as b
  for (const child of node.children) {
    if (child.type === "dotted_name") {
      ctx.candidates.push({
        type: "IMPORT",
        filePath: ctx.filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        referenceName: child.text,
        targetModule: child.text,
        metadata: {
          importedAs: child.text,
          originalName: child.text,
          isDefault: false,
        },
      });
    } else if (child.type === "aliased_import") {
      const nameNode = child.childForFieldName?.("name") ?? child.children[0];
      const aliasNode = child.childForFieldName?.("alias") ?? child.children[2];
      if (nameNode) {
        const originalName = nameNode.text;
        const alias = aliasNode ? aliasNode.text : originalName;
        ctx.candidates.push({
          type: "IMPORT",
          filePath: ctx.filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          referenceName: originalName,
          targetModule: originalName,
          metadata: {
            importedAs: alias,
            originalName,
            alias,
            isDefault: false,
          },
        });
      }
    }
  }
}

function extractPythonFromImport(node: AstNode, ctx: ExtractionContext): void {
  // e.g. from .util import helper as h, other
  const moduleNode =
    node.childForFieldName?.("module_name") ??
    node.children.find(
      (c) => c.type === "dotted_name" || c.type === "relative_import",
    );
  const targetModule = moduleNode ? moduleNode.text : null;

  for (const child of node.children) {
    if (child === moduleNode) continue;

    if (child.type === "dotted_name") {
      ctx.candidates.push({
        type: "IMPORT",
        filePath: ctx.filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        referenceName: child.text,
        targetModule,
        metadata: {
          importedAs: child.text,
          originalName: child.text,
          isDefault: false,
        },
      });
    } else if (child.type === "aliased_import") {
      const nameNode = child.childForFieldName?.("name") ?? child.children[0];
      const aliasNode = child.childForFieldName?.("alias") ?? child.children[2];
      if (nameNode) {
        const originalName = nameNode.text;
        const alias = aliasNode ? aliasNode.text : originalName;
        ctx.candidates.push({
          type: "IMPORT",
          filePath: ctx.filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          referenceName: originalName,
          targetModule,
          metadata: {
            importedAs: alias,
            originalName,
            alias,
            isDefault: false,
          },
        });
      }
    }
  }
}
