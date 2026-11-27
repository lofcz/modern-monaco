import type ts from "typescript";

/**
 * Describes a module's public API from the language service's existing program.
 *
 * Adapted from needle-tools/modern-monaco (MIT), `src/lsp/typescript/apiSymbols.js`.
 */

export interface ApiSymbolQueryOptions {
  /** Dotted path into the module's exports, e.g. `"Camera"` or `"Camera.update"`. Omit to list exports. */
  symbol?: string;
  /** Case-insensitive substring filter for listed exports or members. */
  filter?: string;
  /** Page size for exports, members, signatures and tags (1-60, default 30). */
  limit?: number;
  /** Pagination offset from a previous result's `nextOffset`. */
  offset?: number;
}

export interface ApiSymbolDefinition {
  uri: string;
  line: number;
  column: number;
}

export type ApiSymbolQueryResult =
  | { status: "unresolved"; specifier: string; diagnostics: string[] }
  | {
    status: "resolved";
    specifier: string;
    exports: { name: string }[];
    total: number;
    truncated: boolean;
    nextOffset?: number;
  }
  | {
    status: "not-found";
    specifier: string;
    symbol: string;
    exports?: { name: string }[];
    total?: number;
    truncated?: boolean;
    nextOffset?: number;
  }
  | {
    status: "resolved";
    specifier: string;
    symbol: string;
    type: string;
    signatures: string[];
    documentation: string;
    tags: { name: string; text: string }[];
    definitions: ApiSymbolDefinition[];
    members: { name: string }[];
    memberCount: number;
    truncated: boolean;
    nextOffset?: number;
  };

const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 30;
/** Total characters of type/signature/doc text in one answer, and per item. */
const TEXT_BUDGET = 16_000;
const TEXT_ITEM_MAX = 4_000;

/**
 * Query the API of the module imported by the first import declaration in `uri`.
 * Uses the worker's own program; never creates a second resolver or program.
 */
export function queryApiSymbols(
  tsModule: typeof ts,
  service: ts.LanguageService,
  uri: string,
  specifier: string,
  options: ApiSymbolQueryOptions = {},
): ApiSymbolQueryResult {
  const { SymbolFlags, TypeFormatFlags } = tsModule;
  const program = service.getProgram();
  const source = program?.getSourceFile(uri);
  const checker = program?.getTypeChecker();
  const statement = source?.statements.find((node) => tsModule.isImportDeclaration(node)) as ts.ImportDeclaration | undefined;
  const moduleSymbol = statement && checker?.getSymbolAtLocation(statement.moduleSpecifier);
  if (!source || !checker || !moduleSymbol) {
    return {
      status: "unresolved",
      specifier,
      diagnostics: service.getSemanticDiagnostics(uri)
        .map((d) => tsModule.flattenDiagnosticMessageText(d.messageText, "\n"))
        .slice(0, 8),
    };
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a nonnegative integer");
  }
  const filter = options.filter?.toLowerCase() ?? "";
  const byName = (a: ts.Symbol, b: ts.Symbol) => a.name.localeCompare(b.name);
  const matching = (symbols: ts.Symbol[]) => filter ? symbols.filter((s) => s.name.toLowerCase().includes(filter)) : symbols;
  const names = (symbols: ts.Symbol[]) => symbols.slice(offset, offset + limit).map((s) => ({ name: s.name }));
  const page = (count: number) => offset + limit < count ? { truncated: true, nextOffset: offset + limit } : { truncated: false };

  const unalias = (symbol: ts.Symbol) => symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const typeOf = (symbol: ts.Symbol) =>
    symbol.flags & (SymbolFlags.Interface | SymbolFlags.TypeAlias)
      ? checker.getDeclaredTypeOfSymbol(symbol)
      : checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations?.[0] ?? source);
  const instanceTypeOf = (symbol: ts.Symbol) =>
    symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface) ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;

  const exports = checker.getExportsOfModule(moduleSymbol).sort(byName);
  const matches = matching(exports);
  if (!options.symbol) {
    return { status: "resolved", specifier, exports: names(matches), total: matches.length, ...page(matches.length) };
  }

  const parts = options.symbol.split(".");
  let symbol = exports.find((s) => s.name === parts[0]);
  if (!symbol) {
    return {
      status: "not-found",
      specifier,
      symbol: options.symbol,
      exports: names(matches),
      total: matches.length,
      ...page(matches.length),
    };
  }
  symbol = unalias(symbol);
  for (const part of parts.slice(1)) {
    const parent: ts.Symbol = symbol;
    // Namespaces carry type-only members (interfaces, aliases) that no value type exposes.
    const namespaceMember = parent.flags & (SymbolFlags.Namespace | SymbolFlags.Enum)
      ? checker.getExportsOfModule(parent).find((s) => s.name === part)
      : undefined;
    const instanceType = instanceTypeOf(parent);
    const next = namespaceMember
      ?? checker.getPropertyOfType(typeOf(parent), part)
      ?? (instanceType && checker.getPropertyOfType(instanceType, part));
    if (!next) {
      return { status: "not-found", specifier, symbol: options.symbol };
    }
    symbol = unalias(next);
  }

  const type = typeOf(symbol);
  const memberType = instanceTypeOf(symbol) ?? type;
  const members = matching(checker.getPropertiesOfType(memberType).slice().sort(byName));
  const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
  let remaining = TEXT_BUDGET;
  let textTruncated = false;
  const text = (value: string) => {
    const result = value.slice(0, Math.max(0, Math.min(TEXT_ITEM_MAX, remaining)));
    remaining -= result.length;
    if (result.length < value.length) textTruncated = true;
    return result;
  };
  const memberPage = page(members.length);
  return {
    status: "resolved",
    specifier,
    symbol: options.symbol,
    type: text(checker.typeToString(type, undefined, TypeFormatFlags.NoTruncation)),
    signatures: signatures.slice(0, limit).map((s) => text(checker.signatureToString(s, undefined, TypeFormatFlags.NoTruncation))),
    documentation: text(tsModule.displayPartsToString(symbol.getDocumentationComment(checker))),
    tags: symbol.getJsDocTags(checker).slice(0, limit).map((tag) => ({
      name: tag.name,
      text: text(tsModule.displayPartsToString(tag.text)),
    })),
    definitions: (symbol.declarations ?? []).slice(0, limit).map((node) => {
      const file = node.getSourceFile();
      const location = file.getLineAndCharacterOfPosition(node.getStart());
      return { uri: file.fileName, line: location.line + 1, column: location.character + 1 };
    }),
    members: names(members),
    memberCount: members.length,
    ...memberPage,
    truncated: memberPage.truncated || textTruncated || signatures.length > limit,
  };
}
