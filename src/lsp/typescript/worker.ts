import type monacoNS from "monaco-editor-core";
import type * as lst from "vscode-languageserver-types";
import { ImportMap, type ImportMapRaw } from "@esm.sh/import-map";
// Bundled into the worker at build time (esbuild converts the CJS typescript.js
// to ESM), so the worker is fully self-contained — no CDN/import-map needed to
// resolve its `typescript` import.
import ts from "typescript";
import {
  CompletionItemKind,
  CompletionItemTag,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentHighlightKind,
  FoldingRangeKind,
  Range,
  SelectionRange,
  SymbolKind,
} from "vscode-languageserver-types";
import { TextDocument, WorkerBase, type WorkerCreateData } from "../worker-base.ts";

// ! external modules, don't remove the `.js` extension
// @ts-expect-error 'libs.js' is generated at build time
import libs from "./libs.js";
import { cache } from "../../cache.js";
import { initializeWorker } from "../../editor-worker.js";

export interface Host {
  openModel(uri: string): Promise<boolean>;
  refreshDiagnostics(uri: string): Promise<void>;
}

export interface VersionedContent {
  content: string;
  version: number;
}

export interface CreateData extends WorkerCreateData {
  compilerOptions: Record<string, unknown>;
  formatOptions: ts.FormatCodeSettings & Pick<ts.UserPreferences, "quotePreference">;
  importMap: ImportMapRaw;
  types: Record<string, VersionedContent>;
  /** How bare module specifiers resolve their types. Defaults to "importmap". */
  resolution?: ModuleResolutionMode;
}

/**
 * How bare module specifiers (e.g. `react`) resolve their type definitions:
 * - `"importmap"` (default, backwards compatible): via the import map —
 *   typically fetching `.d.ts` from a CDN (esm.sh) over http.
 * - `"node_modules"`: via the workspace's installed `/node_modules`, like tsc —
 *   reading the real `.d.ts` of each installed package. No network, no import
 *   map required.
 * - `"auto"`: try the import map first, then fall back to `/node_modules`.
 */
export type ModuleResolutionMode = "importmap" | "node_modules" | "auto";

/** TypeScriptWorker removes all but the `fileName` property to avoid serializing circular JSON structures. */
export interface DiagnosticRelatedInformation extends Omit<ts.DiagnosticRelatedInformation, "file"> {
  file: { fileName: string } | undefined;
}

/** May store more in future. For now, this will simply be `true` to indicate when a diagnostic is an unused-identifier diagnostic. */
export interface Diagnostic extends DiagnosticRelatedInformation {
  reportsUnnecessary?: {};
  reportsDeprecated?: {};
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export class TypeScriptWorker extends WorkerBase<Host> implements ts.LanguageServiceHost {
  #compilerOptions: ts.CompilerOptions;
  #languageService: ts.LanguageService;
  #formatOptions?: CreateData["formatOptions"];
  #importMap: ImportMap;
  #importMapVersion: number;
  #resolution: ModuleResolutionMode;
  #types: Record<string, VersionedContent>;
  #urlMappings = new Map<string, string>();
  #typesMappings = new Map<string, string>();
  #httpLibs = new Map<string, string>();
  #httpModules = new Map<string, string>();
  #httpTsModules = new Map<string, string>();
  #redirectedImports: [modelUrl: string, node: ts.Node, url: string][] = [];
  #unknownImports = new Set<string>();
  #badImports = new Set<string>();
  #openPromises = new Map<string, Promise<void>>();
  #fetchPromises = new Map<string, Promise<void>>();
  #httpDocumentCache = new Map<string, TextDocument>();
  /** Resolved package types entry: `file:///node_modules/<pkg>` -> types .d.ts href. */
  #pkgTypes = new Map<string, string>();
  /** package.json text for installed packages: `file:///node_modules/<pkg>/package.json` -> json. */
  #pkgJson = new Map<string, string>();
  /** In-flight package probes, keyed by bare specifier (dedupes host fs_stat round-trips). */
  #pkgProbes = new Map<string, Promise<void>>();
  /**
   * Content of node_modules `.d.ts` files read directly through the fs bridge.
   * Caching text here lets TS read dependency types from worker memory instead
   * of materializing a Monaco model per `.d.ts` — opening thousands of models
   * (e.g. lucide-react) flooded the main thread and froze the editor.
   */
  #nodeModulesContent = new Map<string, string>();
  /** TextDocuments for cached node_modules declarations, keyed by href; the
   *  tuple's first slot is the text it was built from (its cache key). */
  #nodeModulesDocumentCache = new Map<string, [text: string, document: TextDocument]>();
  /** In-flight content fetches, keyed by `.d.ts` href (dedupes parallel reads). */
  #nodeModulesFetches = new Map<string, Promise<void>>();
  /** In-flight bulk package prefetches, keyed by package root. */
  #pkgPrefetches = new Map<string, Promise<void>>();
  /** Declaration twin for an ESM `.js` module href ("" = the module has none). */
  #dtsTwins = new Map<string, string>();
  /** In-flight declaration-twin probes, keyed by module href. */
  #dtsTwinProbes = new Map<string, Promise<void>>();
  /** Bumped when node_modules content is cached, so TS re-reads those files. */
  #nodeModulesVersion = 0;
  /** Bumped when CDN/http `.d.ts` libs are cached (esm.sh etc.). */
  #httpLibsVersion = 0;

  constructor(ctx: monacoNS.worker.IWorkerContext<Host>, createData: CreateData) {
    super(ctx, createData);
    this.#compilerOptions = ts.convertCompilerOptionsFromJson(createData.compilerOptions, ".").options;
    this.#languageService = ts.createLanguageService(this);
    this.#importMap = new ImportMap(createData.importMap, "file:///");
    this.#importMapVersion = 0;
    this.#resolution = createData.resolution ?? "importmap";
    this.#types = createData.types;
    this.#formatOptions = createData.formatOptions;
    this.#updateJsxImportSource();
  }

  // #region language service host

  getCurrentDirectory(): string {
    return "/";
  }

  getDirectories(path: string): string[] {
    // Expose installed DefinitelyTyped packages so tsc's @types lookup works
    // the same as a real node_modules tree (`react` → `@types/react`, …).
    if (path === "/node_modules/@types" || path === "file:///node_modules/@types") {
      const names: string[] = [];
      for (const root of this.nodeModulePaths) {
        const prefix = "file:///node_modules/@types/";
        if (root.startsWith(prefix)) names.push(root.slice(prefix.length));
      }
      return names;
    }
    if (path.startsWith("file:///node_modules/") && this.#resolution === "importmap") {
      // todo: use closest index.html(importmap)
      const dirname = path.slice("file:///node_modules/".length);
      return Object.keys(this.#importMap.imports)
        .filter(key => key !== "@jsxRuntime" && (dirname.length === 0 || key.startsWith(dirname)))
        .map(key => dirname.length > 0 ? key.slice(dirname.length) : key)
        .filter((key) => key !== "/" && key.includes("/"))
        .map(key => key.split("/")[0]);
    }
    return this.readDir(path).filter(([_, type]) => type === 2).map(([name, _]) => name);
  }

  readDirectory(
    path: string,
    extensions?: readonly string[],
    exclude?: readonly string[],
    include?: readonly string[],
    depth?: number,
  ): string[] {
    if (path.startsWith("file:///node_modules/") && this.#resolution === "importmap") {
      // todo: use closest index.html(importmap)
      const dirname = path.slice("file:///node_modules/".length);
      return Object.keys(this.#importMap.imports)
        .filter(key => key !== "@jsxRuntime" && (dirname.length === 0 || key.startsWith(dirname)))
        .map(key => dirname.length > 0 ? key.slice(dirname.length) : key)
        .filter((key) => !key.includes("/"));
    }
    return this.readDir(path, extensions).filter(([_, type]) => type === 1).map(([name, _]) => name);
  }

  fileExists(filename: string): boolean {
    // Bare-specifier type resolution (node_modules mode) resolves real .d.ts
    // files under /node_modules; TS must be allowed to read those — either from
    // the worker's content cache (#nodeModulesContent) or an opened model.
    // Everything else under /node_modules stays invisible to TS.
    // TS queries files by both bare path and `file://` href depending on how
    // they were resolved; match the worker cache on either form.
    if (filename.startsWith("/node_modules/") || filename.startsWith("file:///node_modules/")) {
      return this.#nodeModulesContent.has(filename) || this.hasModel(filename);
    }
    return (
      filename in libs
      || `lib.${filename}.d.ts` in libs
      || filename in this.#types
      || this.#httpLibs.has(filename)
      || this.#httpModules.has(filename)
      || this.#httpTsModules.has(filename)
      || this.hasModel(filename)
    );
  }

  readFile(filename: string): string | undefined {
    return this.#getScriptText(filename);
  }

  getScriptFileNames(): string[] {
    const models = this.getMirrorModels();
    const types = Object.keys(this.#types);
    const libNames = Object.keys(libs);
    const filenames = new Array<string>(
      models.length + types.length + libNames.length + this.#httpLibs.size + this.#httpModules.size + this.#httpTsModules.size,
    );
    let i = 0;
    for (const model of models) {
      filenames[i++] = model.uri.toString();
    }
    for (const filename of types) {
      filenames[i++] = filename;
    }
    for (const filename of libNames) {
      filenames[i++] = filename;
    }
    for (const filename of this.#httpLibs.keys()) {
      filenames[i++] = filename;
    }
    for (const filename of this.#httpModules.keys()) {
      filenames[i++] = filename;
    }
    for (const filename of this.#httpTsModules.keys()) {
      filenames[i++] = filename;
    }
    return filenames;
  }

  // Bumping the project version forces TS to rebuild the program (re-running
  // module resolution + re-reading source files) once asynchronously-fetched
  // node_modules type content lands in the worker cache.
  getProjectVersion(): string {
    // Include http-lib + import-map versions so resolving bare imports to
    // newly-fetched CDN `.d.ts` (esm.sh / same-origin proxy) invalidates the
    // program. Without this, TS keeps the initial `.js`/7016 resolution forever
    // even after x-typescript-types has been fetched and cached.
    //
    // The open-model signature is what lets a file opened later join the
    // program at all: TS skips `getScriptFileNames()` entirely while the
    // project version is unchanged, so without it every feature on a
    // newly-opened file fails with "Could not find source file".
    return "nm" + this.#nodeModulesVersion + ".h" + this.#httpLibsVersion + ".i" + this.#importMapVersion
      + ".m" + this.#mirrorModelsSignature();
  }

  /** Order-independent signature of the synced model set (count + XOR of URI hashes). */
  #mirrorModelsSignature(): string {
    let count = 0;
    let signature = 0;
    for (const model of this.getMirrorModels()) {
      count++;
      const uri = model.uri.toString();
      let hash = 2166136261;
      for (let i = 0; i < uri.length; i++) {
        hash ^= uri.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      signature ^= hash;
    }
    return count + "_" + (signature >>> 0).toString(36);
  }

  getScriptVersion(fileName: string): string {
    if (fileName in this.#types) {
      return String(this.#types[fileName].version);
    }
    if (
      fileName in libs
      || fileName in this.#types
      || this.#httpLibs.has(fileName)
      || this.#httpModules.has(fileName)
      || this.#httpTsModules.has(fileName)
    ) {
      return "1"; // static/remote modules/types
    }
    // node_modules types cached in the worker: version tracks when content was
    // fetched so TS re-reads the file once its text arrives.
    if (this.#nodeModulesContent.has(fileName)) {
      return "nm." + this.#nodeModulesVersion;
    }
    const model = this.getModel(fileName);
    if (model) {
      // change on import map will affect all models
      return this.#importMapVersion + "." + model.version;
    }
    // unknown file
    return "0";
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this.#getScriptText(fileName);
    if (text === undefined) {
      return undefined;
    }
    return ts.ScriptSnapshot.fromString(text);
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this.#compilerOptions;
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    switch (options.target) {
      case 0 /* ES3 */:
      case 1 /* ES5 */:
        return "lib.d.ts";
      case 2 /* ES2015 */:
        return "lib.es6.d.ts";
      case 3 /* ES2016 */:
      case 4 /* ES2017 */:
      case 5 /* ES2018 */:
      case 6 /* ES2019 */:
      case 7 /* ES2020 */:
      case 8 /* ES2021 */:
      case 9 /* ES2022 */:
      case 10 /* ES2023 */:
      case 11 /* ES2024 */:
        return `lib.es${2013 + options.target}.full.d.ts`;
      case 99 /* ESNext */:
        return "lib.esnext.full.d.ts";
      default:
        return "lib.es6.d.ts";
    }
  }

  resolveModuleNameLiterals(
    moduleLiterals: readonly ts.StringLiteralLike[],
    containingFile: string,
    _redirectedReference: ts.ResolvedProjectReference | undefined,
    _options: ts.CompilerOptions,
    _containingSourceFile: ts.SourceFile,
    _reusedNames: readonly ts.StringLiteralLike[] | undefined,
  ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
    this.#redirectedImports = this.#redirectedImports.filter(([modelUrl]) => modelUrl !== containingFile);
    return moduleLiterals.map((literal): ts.ResolvedModuleWithFailedLookupLocations["resolvedModule"] => {
      let specifier = literal.text;
      let importMapResolved = false;
      const [url, resolved] = this.#importMap.resolve(specifier, containingFile);
      importMapResolved = resolved;
      if (importMapResolved) {
        specifier = url;
      }
      // Real node_modules type resolution (opt-in via `resolution`): a bare
      // specifier that the import map doesn't resolve is looked up in the
      // workspace's installed /node_modules, like tsc — reading the real .d.ts
      // of each installed package instead of fetching types from a CDN.
      // "auto" tries the import map first (above), then falls back here.
      if (
        !importMapResolved
        && !isHttpUrl(specifier)
        && !isRelativePath(specifier)
        && this.#resolution !== "importmap"
      ) {
        const nodeResolved = this.#resolveNodeModuleTypes(specifier, containingFile);
        if (nodeResolved) {
          return nodeResolved;
        }
        // In "auto" mode, fall through to the http/CDN path below when the
        // package isn't installed; in "node_modules" mode there is no fallback.
        if (this.#resolution === "node_modules") {
          return undefined;
        }
      }
      if (!importMapResolved && !isHttpUrl(specifier) && !isRelativePath(specifier)) {
        return undefined;
      }
      let moduleUrl: URL;
      try {
        moduleUrl = new URL(specifier, pathToUrl(containingFile));
      } catch (error) {
        return undefined;
      }
      if (getScriptExtension(moduleUrl.pathname) === null) {
        const ext = getScriptExtension(containingFile);
        // use the extension of the containing file which is a dts file
        // when the module name has no extension.
        if (ext === ".d.ts" || ext === ".d.mts" || ext === ".d.cts") {
          moduleUrl.pathname += ext;
        }
      }
      if (this.#httpModules.has(containingFile)) {
        // ignore dependencies of http modules
        return {
          resolvedFileName: moduleUrl.href,
          extension: ".js",
        };
      }
      if (moduleUrl.protocol === "file:") {
        const moduleHref = moduleUrl.href;
        if (this.#badImports.has(moduleHref)) {
          return undefined;
        }
        // Packages built for `moduleResolution: node16`/`bundler` write ESM
        // specifiers into their own declarations (`export { X } from "./X.js"`).
        // tsc resolves those to the sibling declaration file; resolving them to
        // the emitted `.js` drops every type the package ships.
        const twin = this.#resolveDeclarationTwin(moduleUrl, containingFile);
        if (twin) {
          return this.#openAndResolve(twin, containingFile);
        }
        for (const model of this.getMirrorModels()) {
          if (moduleHref === model.uri.toString()) {
            return {
              resolvedFileName: moduleHref,
              extension: getScriptExtension(moduleUrl.pathname) ?? ".js",
            };
          }
        }
        if (!this.hasFileSystemProvider) {
          return undefined;
        }
        if (!this.#openPromises.has(moduleHref)) {
          this.#openPromises.set(
            moduleHref,
            this.host.openModel(moduleHref).then((ok) => {
              if (!ok) {
                this.#badImports.add(moduleHref);
                this.#rollbackVersion(containingFile);
              }
            }).finally(() => {
              this.#openPromises.delete(moduleHref);
              this.host.refreshDiagnostics(containingFile);
            }),
          );
        }
      } else {
        const moduleHref = moduleUrl.href;
        if (this.#badImports.has(moduleHref) || this.#unknownImports.has(moduleHref)) {
          return undefined;
        }
        if (!importMapResolved && this.#urlMappings.has(moduleHref)) {
          const redirectUrl = this.#urlMappings.get(moduleHref)!;
          this.#redirectedImports.push([containingFile, literal, redirectUrl]);
        }
        if (this.#httpModules.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: getScriptExtension(moduleUrl.pathname) ?? ".js",
          };
        }
        if (this.#httpTsModules.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: getScriptExtension(moduleUrl.pathname) ?? ".ts",
          };
        }
        if (this.#typesMappings.has(moduleHref)) {
          return {
            resolvedFileName: this.#typesMappings.get(moduleHref)!,
            extension: ".d.ts",
          };
        }
        if (this.#httpLibs.has(moduleHref)) {
          return {
            resolvedFileName: moduleHref,
            extension: ".d.ts",
          };
        }
        if (!this.#fetchPromises.has(moduleHref)) {
          const isJsxRuntimeUrl = this.#compilerOptions.jsxImportSource === moduleHref + "/jsx-runtime";
          const autoFetch = importMapResolved || isJsxRuntimeUrl || isHttpUrl(containingFile) || isWellKnownCDNURL(moduleUrl);
          // if `autoFetch` is true, fetch the module from the network automatically, otherwise query the cache.
          const promise = autoFetch ? cache.fetch(moduleUrl) : cache.query(moduleUrl);
          this.#fetchPromises.set(
            moduleHref,
            promise.then(async (res) => {
              if (!res) {
                // did not find the module in the cache
                this.#unknownImports.add(moduleHref);
                return;
              }
              if (!res.ok) {
                // bad response
                res.body?.cancel();
                this.#badImports.add(moduleHref);
                return;
              }
              const contentType = res.headers.get("content-type");
              const dts = res.headers.get("x-typescript-types");
              if (res.redirected) {
                this.#urlMappings.set(moduleHref, res.url);
              }
              // Process types even when the response was a redirect — esm.sh
              // often 302s to a .mjs while still advertising x-typescript-types
              // on the final response (or on the cached redirect target).
              if (dts) {
                res.body?.cancel?.();
                const dtsUrl = new URL(dts, res.url || moduleHref);
                const dtsRes = await cache.fetch(dtsUrl);
                if (dtsRes.ok) {
                  const dtsText = await dtsRes.text();
                  // Prefer the request URL when Response.url is empty (some
                  // cache reconstructions omit it) so fileExists/readFile match.
                  const resolvedDts = dtsRes.url || dtsUrl.href;
                  this.#typesMappings.set(moduleHref, resolvedDts);
                  this.#addHttpLib(resolvedDts, dtsText);
                }
              } else if (
                /\.(c|m)?jsx?$/.test(moduleUrl.pathname)
                || (contentType && /^(application|text)\/(javascript|jsx)/.test(contentType))
              ) {
                const esmModulePath = parseEsmModulePath(moduleUrl);
                if (esmModulePath) {
                  const [pkgName, pkgVersion, target, subPath] = esmModulePath;
                  const metaUrl = new URL(`/${pkgName}@${pkgVersion}?meta&target=${target}`, moduleUrl);
                  if (subPath) {
                    metaUrl.pathname += "/" + subPath;
                  }
                  const metaRes = await cache.fetch(metaUrl);
                  if (metaRes.ok) {
                    const { dts } = await metaRes.json();
                    if (dts) {
                      const dtsRes = await cache.fetch(new URL(dts, metaUrl));
                      if (dtsRes.ok) {
                        const dtsText = await dtsRes.text();
                        this.#typesMappings.set(moduleHref, dtsRes.url);
                        this.#addHttpLib(dtsRes.url, dtsText);
                      }
                      res.body?.cancel();
                    } else {
                      this.#httpModules.set(moduleHref, await res.text());
                    }
                  }
                } else {
                  this.#httpModules.set(moduleHref, await res.text());
                }
              } else if (
                /\.(c|m)?tsx?$/.test(moduleUrl.pathname)
                || (contentType && /^(application|text)\/(typescript|tsx)/.test(contentType))
              ) {
                const text = await res.text();
                if (/\.d\.(c|m)?ts$/.test(moduleUrl.pathname)) {
                  this.#addHttpLib(moduleHref, text);
                } else {
                  this.#httpTsModules.set(moduleHref, text);
                }
              } else {
                // not a javascript or typescript module
                res.body?.cancel();
                this.#unknownImports.add(moduleHref);
              }
            }).catch((err) => {
              console.error(`Failed to fetch module: ${moduleHref}`, err);
            }).finally(() => {
              this.#rollbackVersion(containingFile);
              this.#fetchPromises.delete(moduleHref);
              this.host.refreshDiagnostics(containingFile);
            }),
          );
        }
      }
      // resolving modules...
      // If the import-map target is already a `.d.ts`, don't pretend it's JS
      // while the fetch is in flight (avoids a flash of 7016).
      const pendingExt = /\.d\.(c|m)?ts$/i.test(moduleUrl.pathname) ? ".d.ts" : ".js";
      return { resolvedFileName: specifier, extension: pendingExt };
    }).map((resolvedModule) => {
      return { resolvedModule };
    });
  }

  // #endregion

  // #region language features

  async doValidation(uri: string): Promise<lst.Diagnostic[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const ext = getScriptExtension(uri);
    const diagnostics: lst.Diagnostic[] = [];
    try {
      for (const diagnostic of this.#languageService.getSyntacticDiagnostics(uri)) {
        diagnostics.push(this.#convertDiagnostic(document, diagnostic));
      }
      for (const diagnostic of this.#languageService.getSuggestionDiagnostics(uri)) {
        diagnostics.push(this.#convertDiagnostic(document, diagnostic));
      }
      if (ext === ".tsx" || ext?.endsWith("ts")) {
        for (const diagnostic of this.#languageService.getSemanticDiagnostics(uri)) {
          diagnostics.push(this.#convertDiagnostic(document, diagnostic));
        }
      }
    } catch (error) {
      // TypeScript throws when a synced model/URI isn't in the program yet
      // (dependency openModel race, http .d.ts still fetching). Retry on the
      // next content/refresh cycle instead of rejecting the RPC.
      if (
        error instanceof Error
        && error.message.includes("Could not find source file")
      ) {
        return null;
      }
      throw error;
    }
    if (this.#redirectedImports.length > 0) {
      this.#redirectedImports.forEach(([modelUrl, node, url]) => {
        if (modelUrl === uri) {
          diagnostics.push(this.#convertDiagnostic(document, {
            file: undefined,
            start: node.getStart(),
            length: node.getWidth(),
            code: 7000,
            category: ts.DiagnosticCategory.Message,
            messageText: `The module was redirected to ${url}`,
          }));
        }
      });
    }
    return diagnostics;
  }

  async doAutoComplete(uri: string, position: lst.Position, ch: string): Promise<string | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const info = this.#languageService.getJsxClosingTagAtPosition(uri, document.offsetAt(position));
    if (info) {
      return "$0" + info.newText;
    }
    return null;
  }

  async doComplete(uri: string, position: lst.Position): Promise<lst.CompletionList | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const offset = document.offsetAt(position);
    const completions = this.#getCompletionsAtPosition(uri, offset);
    if (!completions) {
      return { isIncomplete: false, items: [] };
    }
    const items: lst.CompletionItem[] = [];
    for (const entry of completions.entries) {
      if (entry.name === "") {
        continue;
      }
      // drop import completions that are in the import map for '.' and '..' imports
      if (entry.kind === "script" && entry.name in this.#importMap.imports || entry.name + "/" in this.#importMap.imports) {
        const { replacementSpan } = entry;
        if (replacementSpan?.length) {
          const replacementText = document.getText({
            start: document.positionAt(replacementSpan.start),
            end: document.positionAt(replacementSpan.start + replacementSpan.length),
          });
          if (replacementText.startsWith(".")) {
            continue;
          }
        }
      }
      // data used for resolving item details (see 'doResolveCompletionItem')
      const data = { entryData: entry.data, context: { uri, offset } };
      const tags: lst.CompletionItemTag[] = [];
      if (entry.kindModifiers?.includes("deprecated")) {
        tags.push(CompletionItemTag.Deprecated);
      }
      items.push({
        label: entry.name,
        insertText: entry.name,
        filterText: entry.filterText,
        sortText: entry.sortText,
        kind: convertTsCompletionItemKind(entry.kind),
        tags,
        data,
      });
    }
    return {
      isIncomplete: !!completions.isIncomplete,
      items: items,
    };
  }

  async doResolveCompletionItem(item: lst.CompletionItem): Promise<lst.CompletionItem | null> {
    if (!item.data?.context) {
      return null;
    }
    const { uri, offset } = item.data.context;
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const details = this.#getCompletionEntryDetails(uri, offset, item.label, item.data.entryData);
    if (!details) {
      return null;
    }
    const detail = ts.displayPartsToString(details.displayParts);
    const documentation = ts.displayPartsToString(details.documentation);
    const additionalTextEdits: lst.TextEdit[] = [];
    if (details.codeActions) {
      details.codeActions.forEach((action) =>
        action.changes.forEach((change) =>
          change.textChanges.forEach(({ span, newText }) => {
            additionalTextEdits.push({
              range: createRangeFromDocumentSpan(document, span),
              newText,
            });
          })
        )
      );
    }
    return { label: item.label, detail, documentation, additionalTextEdits };
  }

  async doHover(uri: string, position: lst.Position): Promise<lst.Hover | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }

    const info = this.#getQuickInfoAtPosition(uri, document.offsetAt(position));
    if (info) {
      const contents = ts.displayPartsToString(info.displayParts);
      const documentation = ts.displayPartsToString(info.documentation);
      const tags = info.tags?.map((tag) => tagStringify(tag)).join("  \n\n") ?? null;
      return {
        range: createRangeFromDocumentSpan(document, info.textSpan),
        contents: [
          { language: "typescript", value: contents },
          documentation + (tags ? "\n\n" + tags : ""),
        ],
      };
    }
    return null;
  }

  async doSignatureHelp(
    uri: string,
    position: number,
    context: monacoNS.languages.SignatureHelpContext,
  ): Promise<lst.SignatureHelp | null> {
    const triggerReason = toTsSignatureHelpTriggerReason(context);
    const items = this.#languageService.getSignatureHelpItems(uri, position, { triggerReason });
    if (!items) {
      return null;
    }

    const activeSignature = items.selectedItemIndex;
    const activeParameter = items.argumentIndex;
    const signatures = items.items.map(item => {
      const signature: lst.SignatureInformation = { label: "", parameters: [] };
      signature.documentation = ts.displayPartsToString(item.documentation);
      signature.label += ts.displayPartsToString(item.prefixDisplayParts);
      item.parameters.forEach((p, i, a) => {
        const label = ts.displayPartsToString(p.displayParts);
        const parameter: lst.ParameterInformation = {
          label: label,
          documentation: ts.displayPartsToString(p.documentation),
        };
        signature.label += label;
        if (signature.parameters) {
          signature.parameters.push(parameter);
        } else {
          signature.parameters = [parameter];
        }
        if (i < a.length - 1) {
          signature.label += ts.displayPartsToString(item.separatorDisplayParts);
        }
      });
      signature.label += ts.displayPartsToString(item.suffixDisplayParts);
      return signature;
    });
    return { signatures, activeSignature, activeParameter };
  }

  async doCodeAction(
    uri: string,
    range: lst.Range,
    context: lst.CodeActionContext,
    formatOptions: lst.FormattingOptions,
  ): Promise<lst.CodeAction[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const errorCodes = context.diagnostics.map(diagnostic => diagnostic.code).filter(Boolean).map(Number);
    const codeFixes = await this.#getCodeFixesAtPosition(uri, start, end, errorCodes, toTsFormatOptions(formatOptions));
    return codeFixes.map(codeFix => {
      const action: lst.CodeAction = {
        title: codeFix.description,
        kind: "quickfix",
      };
      if (codeFix.changes.length > 0) {
        const edits: lst.TextEdit[] = [];
        for (const change of codeFix.changes) {
          for (const { span, newText } of change.textChanges) {
            edits.push({ range: createRangeFromDocumentSpan(document, span), newText });
          }
        }
        action.edit = { changes: { [uri]: edits } };
      }
      if (codeFix.commands?.length) {
        const command: any = codeFix.commands[0];
        action.command = {
          title: command.title,
          command: command.id,
          arguments: command.arguments,
        };
      }
      return action;
    });
  }

  async doRename(uri: string, position: lst.Position, newName: string): Promise<lst.WorkspaceEdit | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }

    const documentPosition = document.offsetAt(position);
    const renameInfo = this.#languageService.getRenameInfo(uri, documentPosition, { allowRenameOfImportPath: true });
    if (!renameInfo.canRename) {
      return null;
    }
    const locations = this.#languageService.findRenameLocations(uri, documentPosition, false, false, {
      providePrefixAndSuffixTextForRename: false,
    });
    if (!locations) {
      return null;
    }
    const changes: Record<string, lst.TextEdit[]> = {};
    locations.map(loc => {
      const edits = changes[loc.fileName] || (changes[loc.fileName] = []);
      const locDocument = this.#getTextDocument(loc.fileName);
      if (locDocument) {
        edits.push({
          range: createRangeFromDocumentSpan(locDocument, loc.textSpan),
          newText: newName,
        });
      }
    });
    return { changes };
  }

  async doFormat(
    uri: string,
    range: lst.Range | null,
    formatOptions: lst.FormattingOptions,
    docText?: string,
  ): Promise<lst.TextEdit[] | null> {
    const document = docText ? TextDocument.create(uri, "typescript", 0, docText) : this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const formattingOptions = this.#mergeFormatOptions(toTsFormatOptions(formatOptions));
    let edits: ts.TextChange[];
    if (range) {
      const start = document.offsetAt(range.start);
      const end = document.offsetAt(range.end);
      edits = this.#languageService.getFormattingEditsForRange(uri, start, end, formattingOptions);
    } else {
      edits = this.#languageService.getFormattingEditsForDocument(uri, formattingOptions);
    }
    return edits.map(({ span, newText }) => ({
      range: createRangeFromDocumentSpan(document, span),
      newText,
    }));
  }

  async findDocumentSymbols(uri: string): Promise<lst.DocumentSymbol[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const toSymbol = (item: ts.NavigationTree, containerLabel?: string): lst.DocumentSymbol => {
      const result: lst.DocumentSymbol = {
        name: item.text,
        kind: convertTsSymbolKind(item.kind),
        range: createRangeFromDocumentSpan(document, item.spans[0]),
        selectionRange: createRangeFromDocumentSpan(document, item.spans[0]),
        children: item.childItems?.map((child) => toSymbol(child, item.text)),
      };
      if (containerLabel) {
        Reflect.set(result, "containerName", containerLabel);
      }
      return result;
    };
    const root = this.#languageService.getNavigationTree(uri);
    return root.childItems?.map((item) => toSymbol(item)) ?? null;
  }

  async findDefinition(uri: string, position: lst.Position): Promise<lst.LocationLink[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const res = this.#languageService.getDefinitionAndBoundSpan(uri, document.offsetAt(position));
    if (res) {
      const { definitions, textSpan } = res;
      if (definitions) {
        return definitions.map(d => {
          const targetDocument = d.fileName === uri ? document : this.#getTextDocument(d.fileName);
          if (targetDocument) {
            const range = createRangeFromDocumentSpan(targetDocument, d.textSpan);
            const link: lst.LocationLink = {
              targetUri: d.fileName,
              targetRange: range,
              targetSelectionRange: undefined as unknown as lst.Range,
            };
            if (d.contextSpan) {
              link.targetRange = createRangeFromDocumentSpan(targetDocument, d.contextSpan);
              link.targetSelectionRange = range;
            }
            if (d.kind === "script" || d.kind === "module") {
              // strip quotes
              link.originSelectionRange = createRangeFromDocumentSpan(document, {
                start: textSpan.start + 1,
                length: textSpan.length - 2,
              });
            } else {
              link.originSelectionRange = createRangeFromDocumentSpan(document, textSpan);
            }
            return link;
          }
          return undefined;
        }).filter(d => d !== undefined);
      }
    }
    return null;
  }

  async findReferences(uri: string, position: lst.Position): Promise<lst.Location[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const references = this.#languageService.getReferencesAtPosition(uri, document.offsetAt(position));
    const result: lst.Location[] = [];
    if (references) {
      for (let entry of references) {
        const entryDocument = this.#getTextDocument(entry.fileName);
        if (entryDocument) {
          result.push({
            uri: entryDocument.uri,
            range: createRangeFromDocumentSpan(entryDocument, entry.textSpan),
          });
        }
      }
    }
    return result;
  }

  async findDocumentHighlights(uri: string, position: lst.Position): Promise<lst.DocumentHighlight[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const highlights = this.#languageService.getDocumentHighlights(uri, document.offsetAt(position), [uri]);
    const out: lst.DocumentHighlight[] = [];
    for (const entry of highlights || []) {
      for (const highlight of entry.highlightSpans) {
        out.push({
          range: createRangeFromDocumentSpan(document, highlight.textSpan),
          kind: highlight.kind === "writtenReference" ? DocumentHighlightKind.Write : DocumentHighlightKind.Text,
        });
      }
    }
    return out;
  }

  async getFoldingRanges(uri: string): Promise<lst.FoldingRange[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    const spans = this.#languageService.getOutliningSpans(uri);
    const ranges: lst.FoldingRange[] = [];
    for (const span of spans) {
      const curr = createRangeFromDocumentSpan(document, span.textSpan);
      const startLine = curr.start.line;
      const endLine = curr.end.line;
      if (startLine < endLine) {
        const foldingRange: lst.FoldingRange = { startLine, endLine };
        const match = document.getText(curr).match(/^\s*\/(?:(\/\s*#(?:end)?region\b)|(\*|\/))/);
        if (match) {
          foldingRange.kind = match[1] ? FoldingRangeKind.Region : FoldingRangeKind.Comment;
        }
        ranges.push(foldingRange);
      }
    }
    return ranges;
  }

  async getSelectionRanges(uri: string, positions: lst.Position[]): Promise<lst.SelectionRange[] | null> {
    const document = this.#getTextDocument(uri);
    if (!document) {
      return null;
    }
    function convertSelectionRange(selectionRange: ts.SelectionRange): lst.SelectionRange {
      const parent = selectionRange.parent ? convertSelectionRange(selectionRange.parent) : undefined;
      return SelectionRange.create(createRangeFromDocumentSpan(document!, selectionRange.textSpan), parent);
    }
    return positions.map(position => {
      const range = this.#languageService.getSmartSelectionRange(uri, document.offsetAt(position));
      return convertSelectionRange(range);
    });
  }

  // #endregion

  // #region public methods used by the host

  async fetchHttpModule(specifier: string, containingFile: string): Promise<void> {
    if (this.#unknownImports.has(specifier)) {
      const res = await cache.fetch(specifier);
      res.body?.cancel();
      this.#unknownImports.delete(specifier);
      if (!res.ok) {
        this.#badImports.add(specifier);
      }
      this.#rollbackVersion(containingFile);
      this.host.refreshDiagnostics(containingFile);
    }
  }

  async updateCompilerOptions(options: {
    compilerOptions?: Record<string, unknown>;
    importMap?: ImportMapRaw;
    types?: Record<string, VersionedContent>;
  }): Promise<void> {
    const { compilerOptions, importMap, types } = options;
    if (compilerOptions) {
      this.#compilerOptions = ts.convertCompilerOptionsFromJson(compilerOptions, ".").options;
      this.#updateJsxImportSource();
    }
    if (importMap) {
      const next = new ImportMap(importMap, "file:///");
      // Avoid clearing CDN type caches + bumping project version when the host
      // re-pushes an identical map after Install (common warm-cache reload).
      const prevJson = JSON.stringify(this.#importMap?.imports ?? {});
      const nextJson = JSON.stringify(next.imports ?? {});
      if (prevJson !== nextJson) {
        this.#importMap = next;
        this.#importMapVersion++;
        this.#typesMappings.clear();
        this.#unknownImports.clear();
        this.#badImports.clear();
        this.#updateJsxImportSource();
      }
    }
    if (types) {
      for (const uri of Object.keys(this.#types)) {
        if (!(uri in types)) {
          this.releaseDocument(uri);
        }
      }
      this.#types = types;
    }
  }

  // #endregion

  // #region private methods

  #getCompletionsAtPosition(fileName: string, position: number): ts.CompletionInfo | undefined {
    const completions = this.#languageService.getCompletionsAtPosition(
      fileName,
      position,
      {
        quotePreference: this.#formatOptions?.quotePreference,
        allowRenameOfImportPath: true,
        importModuleSpecifierEnding: "js",
        importModuleSpecifierPreference: "shortest",
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includePackageJsonAutoImports: "off",
        organizeImportsIgnoreCase: false,
      },
    );
    // filter repeated auto-import suggestions from a types module
    if (completions) {
      const autoImports = new Set<string>();
      completions.entries = completions.entries.filter((entry) => {
        const { data } = entry;
        if (!data || !data.fileName || !isDts(data.fileName)) {
          return true;
        }
        const { moduleSpecifier, exportName } = data;
        if (moduleSpecifier && (moduleSpecifier in this.#importMap.imports || this.#typesMappings.has(moduleSpecifier))) {
          autoImports.add(exportName + " " + moduleSpecifier);
          return true;
        }
        const specifier = this.#getSpecifierFromDts(data.fileName);
        if (specifier && !autoImports.has(exportName + " " + specifier)) {
          autoImports.add(exportName + " " + specifier);
          return true;
        }
        return false;
      });
      return completions;
    }
    return undefined;
  }

  #getCompletionEntryDetails(
    fileName: string,
    position: number,
    entryName: string,
    data?: ts.CompletionEntryData,
  ): ts.CompletionEntryDetails | undefined {
    try {
      const detail = this.#languageService.getCompletionEntryDetails(
        fileName,
        position,
        entryName,
        {
          insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: true,
          semicolons: ts.SemicolonPreference.Insert,
        },
        undefined,
        undefined,
        data,
      );
      // fix the url of auto import suggestions from a types module
      detail?.codeActions?.forEach((action) => {
        if (action.description.startsWith("Add import from ")) {
          const specifier = action.description.slice(17, -1);
          const newSpecifier = this.#getSpecifierFromDts(isDts(specifier) ? specifier : specifier + ".d.ts");
          if (newSpecifier) {
            action.description = `Add type import from "${newSpecifier}"`;
            action.changes.forEach((change) => {
              change.textChanges.forEach((textChange) => {
                textChange.newText = textChange.newText.replace(
                  specifier,
                  newSpecifier,
                );
              });
            });
          }
        }
      });
      return detail;
    } catch (error) {
      return;
    }
  }

  #getQuickInfoAtPosition(fileName: string, position: number): ts.QuickInfo | undefined {
    const info = this.#languageService.getQuickInfoAtPosition(fileName, position);
    if (!info) {
      return;
    }

    // pettier display for module specifiers
    const { kind, kindModifiers, displayParts, textSpan } = info;
    if (kind === ts.ScriptElementKind.moduleElement && displayParts?.length === 3) {
      const moduleName = displayParts[2].text;
      // show pathname for `file:` specifiers
      if (moduleName.startsWith('"file:') && fileName.startsWith("file:")) {
        const literalText = this.getModel(fileName)?.getValue().substring(
          textSpan.start,
          textSpan.start + textSpan.length,
        );
        if (literalText) {
          try {
            const specifier = JSON.parse(literalText);
            displayParts[2].text = '"' + new URL(specifier, fileName).pathname + '"';
          } catch (error) {
            // ignore
          }
        }
      } else if (
        // show module url for `http:` specifiers instead of the types url
        kindModifiers === "declare" && moduleName.startsWith('"http')
      ) {
        const specifier = JSON.parse(moduleName);
        for (const [url, dts] of this.#typesMappings) {
          if (specifier + ".d.ts" === dts) {
            displayParts[2].text = '"' + url + '"';
            info.tags = [{
              name: "types",
              text: [{ kind: "text", text: dts }],
            }];
            const { pathname, hostname } = new URL(url);
            if (isEsmshHost(hostname)) {
              const pathSegments = pathname.split("/").slice(1);
              if (/^v\d+$/.test(pathSegments[0])) {
                pathSegments.shift();
              }
              let scope = "";
              let pkgName = pathSegments.shift();
              if (pkgName?.startsWith("@")) {
                scope = pkgName;
                pkgName = pathSegments.shift();
              }
              if (!pkgName) {
                continue;
              }
              const npmPkgId = [scope, pkgName.split("@")[0]].filter(Boolean).join("/");
              const npmPkgUrl = `https://www.npmjs.com/package/${npmPkgId}`;
              info.tags.unshift({
                name: "npm",
                text: [{ kind: "text", text: `[${npmPkgId}](${npmPkgUrl})` }],
              });
            }
            break;
          }
        }
      }
    }
    return info;
  }

  async #getCodeFixesAtPosition(
    fileName: string,
    start: number,
    end: number,
    errorCodes: number[],
    formatOptions: ts.FormatCodeSettings,
  ): Promise<ts.CodeFixAction[]> {
    let span = [start + 1, end - 1] as [number, number];
    // fix url/path span
    if (start === end && (this.#redirectedImports.length > 0 || errorCodes.includes(2307))) {
      const a = this.#languageService.getReferencesAtPosition(fileName, start);
      if (a && a.length > 0) {
        const b = a[0];
        span = [b.textSpan.start, b.textSpan.start + b.textSpan.length];
      }
    }
    const fixes: ts.CodeFixAction[] = [];
    if (this.#redirectedImports.length > 0) {
      const i = this.#redirectedImports.findIndex(([modelUrl, node]) => {
        return fileName === modelUrl && node.getStart() === span[0] - 1 && node.getEnd() === span[1] + 1;
      });
      if (i >= 0) {
        const [_, node, url] = this.#redirectedImports[i];
        const fixName = `Update module specifier to ${url}`;
        fixes.push({
          fixName,
          description: fixName,
          changes: [{
            fileName,
            textChanges: [{
              span: { start: node.getStart(), length: node.getWidth() },
              newText: JSON.stringify(url),
            }],
          }],
        });
      }
    }
    if (errorCodes.includes(2307)) {
      const specifier = this.getModel(fileName)?.getValue().slice(...span);
      if (specifier) {
        if (this.#unknownImports.has(specifier)) {
          const fixName = `Fetch module from '${specifier}'`;
          fixes.push({
            fixName,
            description: fixName,
            changes: [],
            commands: [{
              id: "ts:fetch_http_module",
              title: "Fetch the module from internet",
              arguments: [specifier, fileName],
            }],
          });
        }
      }
      // else if (/^@?\w[\w\.\-]*(\/|$)/.test(specifier) && importMapSrc) {
      //   const fixName = `Lookup module '${specifier}' on https://esm.sh`;
      //   fixes.push({
      //     fixName,
      //     description: fixName,
      //     changes: [],
      //     commands: [{
      //       id: "lookup-module",
      //       title: "Lookup module on https://esm.sh",
      //       arguments: [importMapSrc, specifier],
      //     }],
      //   });
      // }
    }
    try {
      const tsFixes = this.#languageService.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        errorCodes,
        this.#mergeFormatOptions(formatOptions),
        {},
      );
      return fixes.concat(tsFixes);
    } catch (err) {
      return fixes;
    }
  }

  /** rollback the version to force reinvoke `resolveModuleNameLiterals` method. */
  #rollbackVersion(fileName: string) {
    const model = this.getModel(fileName);
    if (model) {
      // @ts-expect-error private field
      model._versionId--;
    }
  }

  /**
   * Resolve a bare module specifier (e.g. `react`, `react/jsx-runtime`) to the
   * real `.d.ts` of the installed package under `/node_modules`, the way tsc
   * does — reading the package's `package.json` (`types`/`exports`/`main`).
   *
   * Synchronous like the rest of `resolveModuleNameLiterals`: returns a
   * resolution only when the target `.d.ts` is already known (mirror model or
   * walked fs). On a cache miss it kicks off an async package probe that
   * discovers the types entry through the host fs bridge, then rolls the
   * containing file's version back so TS re-resolves — the same pattern the
   * `file:` import branch uses with `host.openModel`.
   */
  #resolveNodeModuleTypes(
    specifier: string,
    containingFile: string,
  ): { resolvedFileName: string; extension: ts.Extension } | undefined {
    const { pkgRoot, pkgName, subpath } = splitNodeSpecifier(specifier);
    if (!pkgName) return undefined;

    const cacheKey = pkgRoot + (subpath ? "/" + subpath : "");

    // Fast path: we already resolved this package's types entry.
    const knownEntry = this.#pkgTypes.get(cacheKey);
    if (knownEntry && (this.hasFsPath(knownEntry) || this.#nodeModulesContent.has(knownEntry) || this.hasModel(knownEntry))) {
      return this.#openAndResolve(knownEntry, containingFile);
    }

    // Synchronous candidate scan: try the conventional .d.ts locations that we
    // already know exist (mirror models / walked fs / stat cache). Also check
    // DefinitelyTyped (`@types/<pkg>`) — react etc. ship no bundled .d.ts.
    const roots = [pkgRoot];
    if (!pkgName.startsWith("@types/")) {
      roots.push("file:///node_modules/" + atTypesPackageName(pkgName));
    }
    for (const root of roots) {
      const pkgJson = this.#pkgJson.get(root + "/package.json");
      for (const candidate of this.#nodeTypesCandidates(root, subpath, pkgJson)) {
        if (this.hasModel(candidate) || this.hasFsPath(candidate) || this.#nodeModulesContent.has(candidate)) {
          this.#pkgTypes.set(cacheKey, candidate);
          return this.#openAndResolve(candidate, containingFile);
        }
      }
    }

    // Miss: asynchronously probe the package via the host fs bridge, then
    // re-resolve. Deduped per specifier.
    if (!this.#pkgProbes.has(specifier)) {
      const probe = this.#probeNodeModule(pkgRoot, pkgName, subpath)
        .finally(() => {
          this.#pkgProbes.delete(specifier);
          this.#rollbackVersion(containingFile);
          this.host.refreshDiagnostics(containingFile);
        });
      this.#pkgProbes.set(specifier, probe);
    }
    return undefined;
  }

  /**
   * Sibling declaration file for an ESM `.js`/`.mjs`/`.cjs` module path.
   *
   * Returns undefined when the module is plain JavaScript with no declaration
   * twin, or when the twin has not been discovered yet — in the latter case an
   * async probe is started and `containingFile` re-resolves once it lands, the
   * same pattern `#resolveNodeModuleTypes` uses.
   */
  #resolveDeclarationTwin(moduleUrl: URL, containingFile: string): string | undefined {
    const twins = declarationTwins(moduleUrl.pathname);
    if (twins.length === 0) return undefined;

    const moduleHref = moduleUrl.href;
    const cached = this.#dtsTwins.get(moduleHref);
    if (cached !== undefined) return cached || undefined;

    const hrefFor = (pathname: string): string => {
      const url = new URL(moduleUrl.href);
      url.pathname = pathname;
      return url.href;
    };

    for (const pathname of twins) {
      const href = hrefFor(pathname);
      if (this.hasModel(href) || this.hasFsPath(href) || this.#nodeModulesContent.has(href)) {
        this.#dtsTwins.set(moduleHref, href);
        return href;
      }
    }

    if (!this.hasFileSystemProvider) return undefined;
    if (!this.#dtsTwinProbes.has(moduleHref)) {
      const probe = (async () => {
        for (const pathname of twins) {
          const href = hrefFor(pathname);
          if (await this.fsProbe(href) === 1) {
            this.#dtsTwins.set(moduleHref, href);
            return;
          }
        }
        this.#dtsTwins.set(moduleHref, "");
      })().finally(() => {
        this.#dtsTwinProbes.delete(moduleHref);
        this.#rollbackVersion(containingFile);
        this.host.refreshDiagnostics(containingFile);
      });
      this.#dtsTwinProbes.set(moduleHref, probe);
    }
    return undefined;
  }

  /** Open the resolved .d.ts as a (background) model and return its resolution. */
  #openAndResolve(
    dtsHref: string,
    containingFile: string,
  ): { resolvedFileName: string; extension: ts.Extension } | undefined {
    const extension = (getScriptExtension(dtsHref) ?? ".d.ts") as ts.Extension;
    for (const model of this.getMirrorModels()) {
      if (dtsHref === model.uri.toString()) {
        return { resolvedFileName: dtsHref, extension };
      }
    }
    if (!this.hasFileSystemProvider) return undefined;
    // node_modules dependency types: cache their text in the worker (fetched
    // via the fs bridge, in parallel) instead of opening a Monaco model per
    // file — see #nodeModulesContent. TS reads it via #getScriptText.
    if (dtsHref.startsWith("file:///node_modules/")) {
      if (!this.#nodeModulesContent.has(dtsHref) && !this.#nodeModulesFetches.has(dtsHref)) {
        this.#nodeModulesFetches.set(
          dtsHref,
          this.fsRead(dtsHref)
            .then((text) => {
              this.#nodeModulesContent.set(dtsHref, text);
              this.#nodeModulesVersion++;
              this.#rollbackVersion(containingFile);
            })
            .catch(() => {
              this.#badImports.add(dtsHref);
              this.#rollbackVersion(containingFile);
            })
            .finally(() => {
              this.#nodeModulesFetches.delete(dtsHref);
              this.host.refreshDiagnostics(containingFile);
            }),
        );
      }
      return { resolvedFileName: dtsHref, extension };
    }
    // Non-node_modules: open the model so TS can read its text; re-resolve after.
    if (!this.#openPromises.has(dtsHref)) {
      this.#openPromises.set(
        dtsHref,
        this.host.openModel(dtsHref).then((ok) => {
          if (!ok) {
            this.#badImports.add(dtsHref);
            this.#rollbackVersion(containingFile);
          }
        }).finally(() => {
          this.#openPromises.delete(dtsHref);
          this.host.refreshDiagnostics(containingFile);
        }),
      );
    }
    return { resolvedFileName: dtsHref, extension };
  }

  /** Conventional .d.ts candidate paths for `<pkgRoot>/<subpath>`. */
  #nodeTypesCandidates(pkgRoot: string, subpath: string, pkgJsonText?: string): string[] {
    const out: string[] = [];
    if (pkgJsonText) {
      try {
        const pkg = JSON.parse(pkgJsonText);
        if (subpath === "") {
          const entry = resolveTypesEntry(pkg);
          if (entry) out.push(pkgRoot + "/" + entry);
        } else {
          const sub = resolveExportsTypes(pkg, subpath);
          if (sub) out.push(pkgRoot + "/" + sub);
        }
      } catch {
        // ignore malformed package.json
      }
    }
    if (subpath === "") {
      out.push(
        pkgRoot + "/index.d.ts",
        pkgRoot + "/index.d.mts",
      );
    } else {
      const base = pkgRoot + "/" + subpath;
      out.push(
        base + ".d.ts",
        base + ".d.mts",
        base + "/index.d.ts",
        base + "/index.d.mts",
      );
    }
    return out;
  }

  /**
   * Probe an installed package through the host fs bridge: read its
   * package.json, compute the types entry, verify the .d.ts exists, then open
   * it as a model so its text is available to the language service.
   * Falls back to DefinitelyTyped (`@types/<pkg>`) when the runtime package
   * ships no types — matching tsc's node_modules resolution.
   */
  async #probeNodeModule(pkgRoot: string, pkgName: string, subpath: string): Promise<void> {
    const cacheKey = pkgRoot + (subpath ? "/" + subpath : "");
    const roots = [pkgRoot];
    if (!pkgName.startsWith("@types/")) {
      roots.push("file:///node_modules/" + atTypesPackageName(pkgName));
    }

    for (const root of roots) {
      const pkgJsonHref = root + "/package.json";
      // Cache the package.json for future synchronous resolutions.
      if (!this.#pkgJson.has(pkgJsonHref)) {
        try {
          this.#pkgJson.set(pkgJsonHref, await this.fsRead(pkgJsonHref));
        } catch {
          this.#pkgJson.set(pkgJsonHref, "");
        }
      }
      const pkgJson = this.#pkgJson.get(pkgJsonHref);
      // Empty package.json means the package (or @types fallback) isn't installed.
      if (!pkgJson) continue;

      // Warm the package's whole .d.ts graph in the background via BATCHED bridge
      // reads (fsReadBatch = one RPC per chunk, not per file), so TS's program
      // build hits the worker cache instead of issuing one RPC per internal
      // import. Without this, a package with thousands of type files (lucide-react)
      // monopolizes the single worker↔main channel for minutes and hover stalls.
      void this.#prefetchNodeModule(root);

      for (const candidate of this.#nodeTypesCandidates(root, subpath, pkgJson)) {
        const type = await this.fsProbe(candidate);
        if (type === 1) {
          this.#pkgTypes.set(cacheKey, candidate);
          // Cache the entry's text now so the first hover on the import resolves
          // to real types without waiting for the background package prefetch.
          if (!this.#nodeModulesContent.has(candidate)) {
            try {
              this.#nodeModulesContent.set(candidate, await this.fsRead(candidate));
            } catch {
              // fall back to on-demand read
            }
          }
          return;
        }
      }
    }
    // No types found; remember so we don't keep probing. (Package may be
    // untyped — that's fine, tsc reports it the same way.) Cleared on later
    // fsNotify when @types lands after install.
    this.#pkgTypes.set(cacheKey, "");
  }

  /**
   * Invalidate negative type-resolution results when `/node_modules` changes
   * (e.g. installer finishes unpacking `@types/react` after an earlier miss).
   */
  override async fsNotify(kind: "create" | "remove" | "modify", path: string, type?: number): Promise<void> {
    await super.fsNotify(kind, path, type);
    if (!path.includes("/node_modules/")) return;
    let cleared = false;
    for (const [key, value] of this.#pkgTypes) {
      if (value === "") {
        this.#pkgTypes.delete(key);
        cleared = true;
      }
    }
    for (const [key, value] of this.#dtsTwins) {
      if (value === "") {
        this.#dtsTwins.delete(key);
        cleared = true;
      }
    }
    // A failed package.json read is what makes #probeNodeModule give up on a
    // package; keeping it cached survives the install that would fix it.
    for (const [key, value] of this.#pkgJson) {
      if (value === "") {
        this.#pkgJson.delete(key);
        cleared = true;
      }
    }
    if (kind === "create") {
      // A prefetch that ran before the package existed found nothing and would
      // never run again; let the next resolution re-walk the package.
      this.#pkgPrefetches.clear();
    }
    if (cleared || kind === "create") {
      this.#nodeModulesVersion++;
    }
  }

  /**
   * Fetch every `.d.ts` file under a package root into the worker cache in a
   * single parallel batch, with a single project-version bump at the end (so
   * TS rebuilds the program once, not once per file). Deduped per package.
   */
  #prefetchNodeModule(pkgRoot: string): Promise<void> {
    let pending = this.#pkgPrefetches.get(pkgRoot);
    if (!pending) {
      pending = (async () => {
        const extensions = [".d.ts", ".d.mts", ".d.cts"];
        let discovered = this.listFilesRecursive(pkgRoot, extensions);
        if (discovered.length === 0) {
          // Installed after the worker's initial workspace walk — bulk installs
          // suppress the per-file watch events that would have indexed it.
          discovered = await this.fsWalk(pkgRoot, extensions);
        }
        const files = discovered.filter((f) => !this.#nodeModulesContent.has(f));
        // Batched reads (one bridge round-trip per chunk) — see fsReadBatch.
        const CHUNK = 64;
        for (let i = 0; i < files.length; i += CHUNK) {
          const chunk = files.slice(i, i + CHUNK);
          const contents = await this.fsReadBatch(chunk);
          for (let j = 0; j < chunk.length; j++) {
            if (contents[j] !== undefined) this.#nodeModulesContent.set(chunk[j], contents[j]!);
          }
        }
        // One bump + one re-resolve for the whole batch.
        this.#nodeModulesVersion++;
      })();
      this.#pkgPrefetches.set(pkgRoot, pending);
    }
    return pending;
  }

  #getScriptText(fileName: string): string | undefined {
    return libs[fileName]
      ?? libs[`lib.${fileName}.d.ts`]
      ?? this.#types[fileName]?.content
      ?? this.#nodeModulesContent.get(fileName)
      ?? this.#httpLibs.get(fileName)
      ?? this.#httpModules.get(fileName)
      ?? this.#httpTsModules.get(fileName)
      ?? this.getModel(fileName)?.getValue();
  }

  #getTextDocument(uri: string): TextDocument | null {
    const doc = this.getTextDocument(uri);
    if (doc) {
      return doc;
    }
    // Dependency declarations live in the worker's content cache rather than a
    // Monaco model (opening a model per `.d.ts` floods the main thread). They
    // still need a document so definitions, references and hovers can report
    // positions inside them — without this, go-to-definition on an import from
    // /node_modules silently returns nothing.
    const nodeModulesText = this.#nodeModulesContent.get(uri);
    if (nodeModulesText !== undefined) {
      const cached = this.#nodeModulesDocumentCache.get(uri);
      if (cached && cached[0] === nodeModulesText) {
        return cached[1];
      }
      const document = TextDocument.create(uri, "typescript", this.#nodeModulesVersion, nodeModulesText);
      this.#nodeModulesDocumentCache.set(uri, [nodeModulesText, document]);
      return document;
    }
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      const docCache = this.#httpDocumentCache;
      if (docCache.has(uri)) {
        return docCache.get(uri)!;
      }
      const scriptText = this.#getScriptText(uri);
      if (scriptText) {
        const doc = TextDocument.create(uri, "typescript", 1, scriptText);
        docCache.set(uri, doc);
        return doc;
      }
    }
    return null;
  }

  #addHttpLib(url: string, dtsContent: string): void {
    const prev = this.#httpLibs.get(url);
    this.#httpLibs.set(url, dtsContent);
    if (prev !== dtsContent) this.#httpLibsVersion++;
    // Prefetch graph edges immediately (no setTimeout). Waiting a tick meant
    // IntelliSense stayed on 7016 until a second diagnostic pass after
    // relatives landed — noticeable with large CDN libs.
    const pull = (refUrl: string) => {
      if (this.#fetchPromises.has(refUrl) || this.#httpLibs.has(refUrl) || this.#badImports.has(refUrl)) {
        return;
      }
      this.#fetchPromises.set(
        refUrl,
        cache.fetch(refUrl).then(async (res) => {
          if (res.ok) {
            this.#addHttpLib(refUrl, await res.text());
          } else {
            this.#badImports.add(refUrl);
          }
        }).catch((err) => {
          console.error(`Failed to fetch types: ${refUrl}`, err);
        }).finally(() => {
          this.#fetchPromises.delete(refUrl);
          this.#httpLibsVersion++;
        }),
      );
    };
    // `/// <reference path="..." />` once the source file exists in the program
    const referencedFiles = this.#languageService.getProgram()?.getSourceFile(url)?.referencedFiles ?? [];
    for (const ref of referencedFiles) {
      const refUrl = new URL(ref.fileName, url).href;
      if (isDts(refUrl)) pull(refUrl);
    }
    // Relative imports / path refs (strip comments — JSDoc examples often
    // contain fake `from './user-context'` paths that 404 on the CDN).
    const code = dtsContent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      let refUrl = new URL(m[1], url).href;
      if (!isDts(refUrl) && !/\.(c|m)?tsx?$/.test(refUrl)) refUrl += ".d.ts";
      if (isDts(refUrl) || /\.(c|m)?tsx?$/.test(refUrl)) pull(refUrl);
    }
    for (const m of code.matchAll(/\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g)) {
      pull(new URL(m[1], url).href);
    }
  }

  #getSpecifierFromDts(filename: string): string | void {
    for (const [specifier, dts] of this.#typesMappings) {
      if (filename === dts) {
        for (const [key, value] of Object.entries(this.#importMap.imports)) {
          if (value === specifier) {
            return key;
          }
        }
        return specifier;
      }
    }
  }

  #convertDiagnostic(document: TextDocument, diagnostic: ts.Diagnostic): lst.Diagnostic {
    const tags: lst.DiagnosticTag[] = [];
    if (diagnostic.reportsUnnecessary) {
      tags.push(DiagnosticTag.Unnecessary);
    }
    if (diagnostic.reportsDeprecated) {
      tags.push(DiagnosticTag.Deprecated);
    }
    return {
      range: createRangeFromDocumentSpan(document, diagnostic),
      code: diagnostic.code,
      severity: convertTsDiagnosticCategory(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: diagnostic.source,
      tags,
      relatedInformation: this.#convertRelatedInformation(document, diagnostic.relatedInformation),
    };
  }

  #convertRelatedInformation(
    document: TextDocument,
    relatedInformation?: ts.DiagnosticRelatedInformation[],
  ): lst.DiagnosticRelatedInformation[] {
    if (!relatedInformation) {
      return [];
    }

    const result: lst.DiagnosticRelatedInformation[] = [];
    relatedInformation.forEach((info) => {
      const doc = info.file ? this.#getTextDocument(info.file.fileName) : document;
      if (!doc) {
        return;
      }

      const start = doc.positionAt(info.start ?? 0);
      const end = doc.positionAt((info.start ?? 0) + (info.length ?? 1));
      result.push({
        location: {
          uri: document.uri,
          range: Range.create(start, end),
        },
        message: ts.flattenDiagnosticMessageText(info.messageText, "\n"),
      });
    });
    return result;
  }

  #getJsxImportSourceFromImportMap(): string | undefined {
    const { imports } = this.#importMap;
    for (const key of Object.keys(imports)) {
      if (key.endsWith("/jsx-runtime")) {
        return key.slice(0, -12);
      } else if (key.endsWith("/jsx-dev-runtime")) {
        return key.slice(0, -16);
      }
    }
    for (const key of ["react", "preact", "solid-js", "mono-jsx/dom", "mono-jsx"]) {
      if (key + "/" in imports) {
        return key;
      }
    }
    return undefined;
  }

  #updateJsxImportSource(): void {
    if (!this.#compilerOptions.jsxImportSource) {
      const jsxImportSource = this.#getJsxImportSourceFromImportMap();
      if (jsxImportSource) {
        this.#compilerOptions.jsx = ts.JsxEmit.React;
        this.#compilerOptions.jsxImportSource = jsxImportSource;
      }
    }
  }

  #mergeFormatOptions(formatOptions: ts.FormatCodeSettings): ts.FormatCodeSettings {
    return { ...this.#formatOptions, ...formatOptions };
  }

  // #endregion
}

function getScriptExtension(url: URL | string): string | null {
  const pathname = typeof url === "string" ? pathToUrl(url).pathname : url.pathname;
  const basename = pathname.substring(pathname.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  const ext = basename.substring(dotIndex + 1);
  switch (ext) {
    case "ts":
      return basename.endsWith(".d.ts") ? ".d.ts" : ".ts";
    case "mts":
      return basename.endsWith(".d.mts") ? ".d.mts" : ".mts";
    case "cts":
      return basename.endsWith(".d.cts") ? ".d.cts" : ".cts";
    case "tsx":
      return ".tsx";
    case "js":
      return ".js";
    case "mjs":
      return ".js";
    case "cjs":
      return ".cjs";
    case "jsx":
      return ".jsx";
    case "json":
      return ".json";
    default:
      return ".js";
  }
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isRelativePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

function isEsmshHost(hostname: string): boolean {
  return hostname === "esm.sh" || hostname.endsWith(".esm.sh");
}

const ESM_TARGETS = new Set([
  "es2015",
  "es2016",
  "es2017",
  "es2018",
  "es2019",
  "es2020",
  "es2021",
  "es2022",
  "es2023",
  "es2024",
  "esnext",
  "denonext",
  "deno",
  "node",
]);

// parse the esm module path from the url
// e.g. https://esm.sh/react@18.3.1/es2022/jsx-runtime.mjs
// return ['react', '18.3.1', 'es2022', 'jsx-runtime']
function parseEsmModulePath({ protocol, pathname }: URL): null | [string, string, string, string] {
  if ((protocol !== "https:" && protocol !== "http:") || !pathname.endsWith(".mjs")) {
    return null;
  }
  if (pathname.startsWith("/gh") || pathname.startsWith("/pr")) {
    pathname = pathname.slice(3);
  } else if (pathname.startsWith("/jsr")) {
    pathname = pathname.slice(4);
  }
  const segments = pathname.split("/").slice(1);
  if (segments.length < 3) {
    return null;
  }
  let fristSegment = segments[0];
  let pkgName: string;
  let pkgNameNoScope: string;
  let pkgVersion: string;
  let target: string;
  let hasTargetSegment: boolean;
  let subPath: string;
  if (fristSegment.startsWith("*")) {
    // remove the leading star modifier(external all) of esm.sh
    fristSegment = fristSegment.slice(1);
  }
  if (fristSegment.startsWith("@")) {
    [pkgNameNoScope, pkgVersion] = segments[1].split("@");
    pkgName = fristSegment + "/" + pkgNameNoScope;
    target = segments[2];
    hasTargetSegment = ESM_TARGETS.has(target);
    subPath = segments.slice(3).join("/");
  } else {
    [pkgNameNoScope, pkgVersion] = fristSegment.split("@");
    pkgName = pkgNameNoScope;
    target = segments[1];
    hasTargetSegment = ESM_TARGETS.has(target);
    subPath = segments.slice(2).join("/");
  }
  if (!pkgName || !pkgVersion || !hasTargetSegment || !subPath) {
    return null;
  }
  subPath = subPath.slice(0, -4);
  if (subPath.endsWith(".development")) {
    subPath = subPath.slice(0, -12);
  }
  if (subPath === pkgNameNoScope) {
    return [pkgName, pkgVersion, target, ""];
  }
  if (subPath === "__" + pkgNameNoScope) {
    subPath = pkgNameNoScope;
  }
  return [pkgName, pkgVersion, target, subPath];
}

const regexpESMPath = /\/((@|gh\/|pr\/|jsr\/@)[\w\.\-]+\/)?[\w\.\-]+@(\d+(\.\d+){0,2}(\-[\w\.]+)?|next|canary|rc|beta|latest)$/;

function isWellKnownCDNURL(url: URL): boolean {
  const { pathname } = url;
  return regexpESMPath.test(pathname);
}

function isDts(fileName: string): boolean {
  return fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts") || fileName.endsWith(".d.cts");
}

/**
 * Declaration-file twins for a JS module path, in tsc's lookup order. Empty for
 * paths that are not JavaScript (nothing to substitute).
 */
function declarationTwins(pathname: string): string[] {
  if (pathname.endsWith(".mjs")) {
    const base = pathname.slice(0, -4);
    return [base + ".d.mts", base + ".mts"];
  }
  if (pathname.endsWith(".cjs")) {
    const base = pathname.slice(0, -4);
    return [base + ".d.cts", base + ".cts"];
  }
  if (pathname.endsWith(".jsx")) {
    const base = pathname.slice(0, -4);
    return [base + ".d.ts", base + ".tsx"];
  }
  if (pathname.endsWith(".js")) {
    const base = pathname.slice(0, -3);
    return [base + ".d.ts", base + ".ts", base + ".tsx"];
  }
  return [];
}

/** Split a bare specifier into its package root href, package name, and subpath. */
function splitNodeSpecifier(specifier: string): { pkgRoot: string; pkgName: string; subpath: string } {
  const parts = specifier.split("/");
  let pkgName: string;
  let rest: string[];
  if (specifier.startsWith("@")) {
    pkgName = parts.slice(0, 2).join("/");
    rest = parts.slice(2);
  } else {
    pkgName = parts[0];
    rest = parts.slice(1);
  }
  return {
    pkgRoot: "file:///node_modules/" + pkgName,
    pkgName,
    subpath: rest.join("/"),
  };
}

/**
 * DefinitelyTyped package name for a runtime package.
 * `react` → `@types/react`, `@babel/core` → `@types/babel__core`.
 */
function atTypesPackageName(pkgName: string): string {
  if (pkgName.startsWith("@types/")) return pkgName;
  if (pkgName.startsWith("@")) {
    const [scope, name] = pkgName.slice(1).split("/");
    return `@types/${scope}__${name}`;
  }
  return `@types/${pkgName}`;
}

/**
 * Pick the types entry file from a package.json, honouring `types`/`typings`,
 * then the `exports` "." types condition, then the `.d.ts` twin of
 * `main`/`module`.
 */
function resolveTypesEntry(pkg: Record<string, unknown>): string | null {
  const types = pkg["types"] ?? pkg["typings"];
  if (typeof types === "string") return stripLeadingDotSlash(types);
  const exportsTypes = resolveExportsTypes(pkg, ".");
  if (exportsTypes) return exportsTypes;
  for (const key of ["main", "module"]) {
    const v = pkg[key];
    if (typeof v === "string") {
      const dts = v.replace(/\.(m?js|cjs)$/, "");
      return stripLeadingDotSlash(dts) + ".d.ts";
    }
  }
  return null;
}

/** Resolve the `types` condition of an `exports` subpath (`"."` for the entry). */
function resolveExportsTypes(pkg: Record<string, unknown>, subpath: string): string | null {
  const exports = pkg["exports"];
  if (exports == null || typeof exports !== "object") return null;
  const key = subpath === "" || subpath === "." ? "." : "./" + subpath;
  const pickTypes = (v: unknown): string | null => {
    if (typeof v === "string") {
      // A string target that is itself a .d.ts is the types entry.
      return isDts(v) ? stripLeadingDotSlash(v) : null;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // Prefer the explicit `types` condition, then recurse into import/require/default.
      if ("types" in o) {
        const r = pickTypes(o["types"]);
        if (r) return r;
      }
      for (const cond of ["import", "require", "node", "default"]) {
        if (cond in o) {
          const r = pickTypes(o[cond]);
          if (r) return r;
        }
      }
    }
    return null;
  };
  const o = exports as Record<string, unknown>;
  if (key in o) return pickTypes(o[key]);
  // No subpath keys → the whole exports object is the entry conditions.
  if (!Object.keys(o).some((k) => k.startsWith("."))) return pickTypes(o);
  return null;
}

function stripLeadingDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

function pathToUrl(path: string): URL {
  return new URL(path, "file:///");
}

function createRangeFromDocumentSpan(document: TextDocument, span: { start?: number; length?: number }): lst.Range {
  if (typeof span.start === "undefined") {
    const pos = document.positionAt(0);
    return Range.create(pos, pos);
  }
  const start = document.positionAt(span.start);
  const end = document.positionAt(span.start + (span.length ?? 0));
  return Range.create(start, end);
}

function convertTsCompletionItemKind(kind: ts.ScriptElementKind): lst.CompletionItemKind {
  const ScriptElementKind = ts.ScriptElementKind;
  switch (kind) {
    case ScriptElementKind.primitiveType:
    case ScriptElementKind.keyword:
      return CompletionItemKind.Keyword;
    case ScriptElementKind.constElement:
    case ScriptElementKind.letElement:
    case ScriptElementKind.variableElement:
    case ScriptElementKind.localVariableElement:
    case ScriptElementKind.alias:
    case ScriptElementKind.parameterElement:
      return CompletionItemKind.Variable;
    case ScriptElementKind.memberVariableElement:
    case ScriptElementKind.memberGetAccessorElement:
    case ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Field;
    case ScriptElementKind.functionElement:
    case ScriptElementKind.localFunctionElement:
      return CompletionItemKind.Function;
    case ScriptElementKind.memberFunctionElement:
    case ScriptElementKind.constructSignatureElement:
    case ScriptElementKind.callSignatureElement:
    case ScriptElementKind.indexSignatureElement:
      return CompletionItemKind.Method;
    case ScriptElementKind.enumElement:
      return CompletionItemKind.Enum;
    case ScriptElementKind.enumMemberElement:
      return CompletionItemKind.EnumMember;
    case ScriptElementKind.moduleElement:
    case ScriptElementKind.externalModuleName:
      return CompletionItemKind.Module;
    case ScriptElementKind.classElement:
    case ScriptElementKind.typeElement:
      return CompletionItemKind.Class;
    case ScriptElementKind.interfaceElement:
      return CompletionItemKind.Interface;
    case ScriptElementKind.warning:
      return CompletionItemKind.Text;
    case ScriptElementKind.scriptElement:
      return CompletionItemKind.File;
    case ScriptElementKind.directory:
      return CompletionItemKind.Folder;
    case ScriptElementKind.string:
      return CompletionItemKind.Constant;
    default:
      return CompletionItemKind.Property;
  }
}

function convertTsSymbolKind(kind: ts.ScriptElementKind): lst.SymbolKind {
  const Kind = ts.ScriptElementKind;
  switch (kind) {
    case Kind.memberVariableElement:
    case Kind.memberGetAccessorElement:
    case Kind.memberSetAccessorElement:
      return SymbolKind.Field;
    case Kind.functionElement:
    case Kind.localFunctionElement:
      return SymbolKind.Function;
    case Kind.memberFunctionElement:
    case Kind.constructSignatureElement:
    case Kind.callSignatureElement:
    case Kind.indexSignatureElement:
      return SymbolKind.Method;
    case Kind.enumElement:
      return SymbolKind.Enum;
    case Kind.enumMemberElement:
      return SymbolKind.EnumMember;
    case Kind.moduleElement:
    case Kind.externalModuleName:
      return SymbolKind.Module;
    case Kind.classElement:
    case Kind.typeElement:
      return SymbolKind.Class;
    case Kind.interfaceElement:
      return SymbolKind.Interface;
    case Kind.scriptElement:
      return SymbolKind.File;
    case Kind.string:
      return SymbolKind.Constant;
    default:
      return SymbolKind.Variable;
  }
}

function convertTsDiagnosticCategory(category: ts.DiagnosticCategory): lst.DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Message:
      return DiagnosticSeverity.Information;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Hint;
  }
  return DiagnosticSeverity.Information;
}

function tagStringify(tag: ts.JSDocTagInfo): string {
  let tagLabel = `*@${tag.name}*`;
  if (tag.name === "param" && tag.text) {
    const [paramName, ...rest] = tag.text;
    tagLabel += `\`${paramName.text}\``;
    if (rest.length > 0) tagLabel += ` — ${rest.map((r) => r.text).join(" ")}`;
  } else if (Array.isArray(tag.text)) {
    tagLabel += ` — ${tag.text.map((r) => r.text).join("")}`;
  } else if (tag.text) {
    tagLabel += ` — ${tag.text}`;
  }
  return tagLabel;
}

function toTsSignatureHelpTriggerReason(context: monacoNS.languages.SignatureHelpContext): ts.SignatureHelpTriggerReason {
  switch (context.triggerKind) {
    case 3 /* ContentChange */:
      return context.isRetrigger ? { kind: "retrigger" } : { kind: "invoked" };
    case 2 /* TriggerCharacter */:
      if (context.triggerCharacter) {
        if (context.isRetrigger) {
          return {
            kind: "retrigger",
            triggerCharacter: context.triggerCharacter as any,
          };
        } else {
          return {
            kind: "characterTyped",
            triggerCharacter: context.triggerCharacter as any,
          };
        }
      } else {
        return { kind: "invoked" };
      }
    case 1 /* Invoke */:
    default:
      return { kind: "invoked" };
  }
}

function toTsFormatOptions({ tabSize, trimTrailingWhitespace, insertSpaces }: lst.FormattingOptions): ts.FormatCodeSettings {
  return {
    tabSize,
    trimTrailingWhitespace,
    indentSize: tabSize,
    convertTabsToSpaces: insertSpaces,
    insertSpaceAfterCommaDelimiter: insertSpaces,
    insertSpaceAfterSemicolonInForStatements: insertSpaces,
    insertSpaceBeforeAndAfterBinaryOperators: insertSpaces,
    insertSpaceAfterKeywordsInControlFlowStatements: insertSpaces,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: insertSpaces,
  };
}

initializeWorker(TypeScriptWorker);
