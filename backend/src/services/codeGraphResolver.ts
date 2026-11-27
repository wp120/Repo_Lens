import path from "node:path";
import type {
  StorableSymbol,
  StorableRelationship,
  ResolvedRelationshipUpdate,
} from "./codeGraphStore.js";

export interface GraphResolutionResult {
  updates: ResolvedRelationshipUpdate[];
  resolvedCount: number;
  unresolvedCount: number;
}

const COMMON_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  ".py",
  "/__init__.py",
];

function normalizeFilePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function resolveModulePath(
  sourceFilePath: string,
  targetModule: string | null | undefined,
  repositoryFilesSet: Set<string>,
): string | null {
  if (!targetModule) return null;

  const normalizedSource = normalizeFilePath(sourceFilePath);
  const sourceDir = path.posix.dirname(normalizedSource);

  // 1. Relative imports starting with . or ..
  if (targetModule.startsWith(".")) {
    const joined = path.posix.normalize(
      path.posix.join(sourceDir, targetModule),
    );
    for (const ext of COMMON_EXTENSIONS) {
      const candidate = normalizeFilePath(joined + ext);
      if (repositoryFilesSet.has(candidate)) {
        return candidate;
      }
    }
  }

  // 2. Python-style relative imports (e.g. .util or ..services)
  if (/^\.+[a-zA-Z0-9_]/.test(targetModule)) {
    const dotCount = targetModule.match(/^\.+/)![0].length;
    const rest = targetModule.slice(dotCount).replace(/\./g, "/");
    let baseDir = sourceDir;
    for (let i = 1; i < dotCount; i++) {
      baseDir = path.posix.dirname(baseDir);
    }
    const joined = path.posix.normalize(path.posix.join(baseDir, rest));
    for (const ext of [".py", "/__init__.py", ""]) {
      const candidate = normalizeFilePath(joined + ext);
      if (repositoryFilesSet.has(candidate)) {
        return candidate;
      }
    }
  }

  // 3. Absolute or repo-relative path (e.g. src/services/auth or app.models)
  const normalizedModule = normalizeFilePath(targetModule);
  for (const ext of COMMON_EXTENSIONS) {
    const candidate = normalizeFilePath(normalizedModule + ext);
    if (repositoryFilesSet.has(candidate)) {
      return candidate;
    }
  }

  // Python module dot notation: app.services.auth -> app/services/auth.py
  const asPath = targetModule.replace(/\./g, "/");
  for (const ext of [".py", "/__init__.py"]) {
    const candidate = normalizeFilePath(asPath + ext);
    if (repositoryFilesSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

interface ImportScopeEntry {
  targetSymbolId?: string;
  targetFile?: string;
  isNamespace?: boolean;
}

export async function resolveGraphRelationships(
  repositoryFilePaths: string[],
  symbols: StorableSymbol[],
  relationships: StorableRelationship[],
): Promise<GraphResolutionResult> {
  const fileSet = new Set(repositoryFilePaths.map(normalizeFilePath));

  // Build symbol lookup tables
  const symbolsById = new Map<string, StorableSymbol>();
  const symbolsByFileAndName = new Map<string, Map<string, StorableSymbol[]>>();
  const symbolsByFile = new Map<string, StorableSymbol[]>();
  const allSymbolsByName = new Map<string, StorableSymbol[]>();

  for (const sym of symbols) {
    symbolsById.set(sym.id, sym);
    const normFile = normalizeFilePath(sym.filePath);

    // By file
    let fileSyms = symbolsByFile.get(normFile);
    if (!fileSyms) {
      fileSyms = [];
      symbolsByFile.set(normFile, fileSyms);
    }
    fileSyms.push(sym);

    // By file and name
    let fileMap = symbolsByFileAndName.get(normFile);
    if (!fileMap) {
      fileMap = new Map();
      symbolsByFileAndName.set(normFile, fileMap);
    }
    let nameList = fileMap.get(sym.name);
    if (!nameList) {
      nameList = [];
      fileMap.set(sym.name, nameList);
    }
    nameList.push(sym);

    // All symbols by name
    let globalList = allSymbolsByName.get(sym.name);
    if (!globalList) {
      globalList = [];
      allSymbolsByName.set(sym.name, globalList);
    }
    globalList.push(sym);
  }

  // Per-file import scopes: Map<filePath, Map<importedAs, ImportScopeEntry>>
  const importScopes = new Map<string, Map<string, ImportScopeEntry>>();

  // Pass 1: Resolve all IMPORT candidates and populate import scopes
  const updates: ResolvedRelationshipUpdate[] = [];
  const importCandidates = relationships.filter((r) => r.type === "IMPORT");
  const otherCandidates = relationships.filter((r) => r.type !== "IMPORT");

  for (let idx = 0; idx < importCandidates.length; idx++) {
    const rel = importCandidates[idx];
    const normSourceFile = normalizeFilePath(rel.filePath);
    let fileScope = importScopes.get(normSourceFile);
    if (!fileScope) {
      fileScope = new Map();
      importScopes.set(normSourceFile, fileScope);
    }

    const resolvedFile = resolveModulePath(
      normSourceFile,
      rel.targetModule,
      fileSet,
    );

    const importedAs =
      (rel.metadata?.importedAs as string) ||
      (rel.metadata?.alias as string) ||
      rel.referenceName;
    const isDefault = Boolean(rel.metadata?.isDefault);
    const isNamespace = Boolean(rel.metadata?.isNamespace);

    if (!resolvedFile) {
      // External module or module not found in repo
      updates.push({
        id: rel.id,
        toSymbolId: null,
        isResolved: false,
        resolutionError: "external_module",
      });
      continue;
    }

    if (isNamespace) {
      fileScope.set(importedAs, {
        targetFile: resolvedFile,
        isNamespace: true,
      });
      updates.push({
        id: rel.id,
        toSymbolId: null,
        isResolved: true,
        resolutionError: null,
      });
      continue;
    }

    const targetFileSyms = symbolsByFileAndName.get(resolvedFile);
    const targetCandidates = targetFileSyms?.get(rel.referenceName) ?? [];

    if (targetCandidates.length === 1) {
      const targetSym = targetCandidates[0];
      fileScope.set(importedAs, {
        targetSymbolId: targetSym.id,
        targetFile: resolvedFile,
      });
      updates.push({
        id: rel.id,
        toSymbolId: targetSym.id,
        isResolved: true,
        resolutionError: null,
      });
    } else if (targetCandidates.length > 1) {
      updates.push({
        id: rel.id,
        toSymbolId: null,
        isResolved: false,
        resolutionError: "ambiguous_target",
      });
    } else {
      // Check if it's default import and there's a symbol with kind class/function or default
      if (isDefault) {
        const fileAll = symbolsByFile.get(resolvedFile) ?? [];
        const defaultMatch =
          fileAll.find((s) => s.name === rel.referenceName) ||
          fileAll.find((s) => s.name === "default") ||
          (fileAll.length === 1 ? fileAll[0] : null);
        if (defaultMatch) {
          fileScope.set(importedAs, {
            targetSymbolId: defaultMatch.id,
            targetFile: resolvedFile,
          });
          updates.push({
            id: rel.id,
            toSymbolId: defaultMatch.id,
            isResolved: true,
            resolutionError: null,
          });
          continue;
        }
      }

      updates.push({
        id: rel.id,
        toSymbolId: null,
        isResolved: false,
        resolutionError: "symbol_not_found",
      });
    }

    if (idx > 0 && idx % 100 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // Pass 2: Resolve CALL, INHERITS, IMPLEMENTS candidates
  for (let idx = 0; idx < otherCandidates.length; idx++) {
    const rel = otherCandidates[idx];
    const normSourceFile = normalizeFilePath(rel.filePath);
    const fileScope = importScopes.get(normSourceFile);
    const receiver = rel.metadata?.receiver as string | undefined;

    let targetSymbolId: string | null = null;
    let resolutionError: string | null = null;

    if (rel.type === "CALL") {
      // 1. Qualified call with receiver
      if (receiver) {
        const fromSym = rel.fromSymbolId
          ? symbolsById.get(rel.fromSymbolId)
          : null;
        const containerName = fromSym?.containerName;

        if (receiver === "this" && containerName) {
          // Look in same class
          const localClassSyms = symbolsByFile.get(normSourceFile) ?? [];
          const methodMatch = localClassSyms.find(
            (s) =>
              s.name === rel.referenceName &&
              s.containerName === containerName &&
              s.kind === "method",
          );
          if (methodMatch) {
            targetSymbolId = methodMatch.id;
          } else {
            resolutionError = "method_not_found_on_class";
          }
        } else if (
          fileScope?.has(receiver) &&
          fileScope.get(receiver)!.isNamespace
        ) {
          // Namespace receiver: receiver.func() -> targetFile has func
          const nsEntry = fileScope.get(receiver)!;
          const targetFileSyms =
            symbolsByFileAndName
              .get(nsEntry.targetFile!)
              ?.get(rel.referenceName) ?? [];
          if (targetFileSyms.length === 1) {
            targetSymbolId = targetFileSyms[0].id;
          } else if (targetFileSyms.length > 1) {
            resolutionError = "ambiguous_target";
          } else {
            resolutionError = "symbol_not_found";
          }
        } else {
          resolutionError = "unresolved_receiver";
        }
      } else {
        // Direct call
        // 1. Check local file definitions
        const localCandidates =
          symbolsByFileAndName.get(normSourceFile)?.get(rel.referenceName) ??
          [];
        if (localCandidates.length === 1) {
          targetSymbolId = localCandidates[0].id;
        } else if (localCandidates.length > 1) {
          resolutionError = "ambiguous_target";
        } else if (fileScope?.has(rel.referenceName)) {
          // 2. Check file import scope
          const imported = fileScope.get(rel.referenceName)!;
          if (imported.targetSymbolId) {
            targetSymbolId = imported.targetSymbolId;
          } else {
            resolutionError = "unresolved_import";
          }
        } else {
          // Unresolved reference: do not blindly match names across files!
          resolutionError = "unresolved_reference";
        }
      }
    } else if (rel.type === "INHERITS") {
      // 1. Check local file
      const localClasses = (symbolsByFile.get(normSourceFile) ?? []).filter(
        (s) => s.name === rel.referenceName && s.kind === "class",
      );
      if (localClasses.length === 1) {
        targetSymbolId = localClasses[0].id;
      } else if (localClasses.length > 1) {
        resolutionError = "ambiguous_target";
      } else if (fileScope?.has(rel.referenceName)) {
        // 2. Check imports
        const imported = fileScope.get(rel.referenceName)!;
        if (imported.targetSymbolId) {
          targetSymbolId = imported.targetSymbolId;
        } else {
          resolutionError = "unresolved_import";
        }
      } else {
        const repoMatches = (
          allSymbolsByName.get(rel.referenceName) ?? []
        ).filter((s) => s.kind === "class");
        if (repoMatches.length > 1) {
          resolutionError = "ambiguous_target";
        } else if (repoMatches.length === 0) {
          resolutionError = "symbol_not_found";
        } else {
          resolutionError = "unimported_reference";
        }
      }
    } else if (rel.type === "IMPLEMENTS") {
      // 1. Check local file
      const localInterfaces = (symbolsByFile.get(normSourceFile) ?? []).filter(
        (s) =>
          s.name === rel.referenceName &&
          (s.kind === "interface" || s.kind === "class"),
      );
      if (localInterfaces.length === 1) {
        targetSymbolId = localInterfaces[0].id;
      } else if (localInterfaces.length > 1) {
        resolutionError = "ambiguous_target";
      } else if (fileScope?.has(rel.referenceName)) {
        // 2. Check imports
        const imported = fileScope.get(rel.referenceName)!;
        if (imported.targetSymbolId) {
          targetSymbolId = imported.targetSymbolId;
        } else {
          resolutionError = "unresolved_import";
        }
      } else {
        const repoMatches = (
          allSymbolsByName.get(rel.referenceName) ?? []
        ).filter((s) => s.kind === "interface" || s.kind === "class");
        if (repoMatches.length > 1) {
          resolutionError = "ambiguous_target";
        } else if (repoMatches.length === 0) {
          resolutionError = "symbol_not_found";
        } else {
          resolutionError = "unimported_reference";
        }
      }
    }

    updates.push({
      id: rel.id,
      toSymbolId: targetSymbolId,
      isResolved: targetSymbolId !== null,
      resolutionError: targetSymbolId !== null ? null : resolutionError,
    });

    if (idx > 0 && idx % 100 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const resolvedCount = updates.filter((u) => u.isResolved).length;
  const unresolvedCount = updates.length - resolvedCount;

  return { updates, resolvedCount, unresolvedCount };
}
