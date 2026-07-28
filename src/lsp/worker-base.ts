import type monacoNS from "monaco-editor-core";
import type { FileStat, FileSystemEntryType } from "../../types/workspace.d.ts";
import { TextDocument } from "vscode-languageserver-textdocument";

export interface WorkerCreateData {
  fs?: string[];
}

export class WorkerBase<Host = undefined, LanguageDocument = undefined> {
  #ctx: monacoNS.worker.IWorkerContext<Host>;
  #fs?: Map<string, FileSystemEntryType>;
  #documentCache = new Map<string, [number, TextDocument, LanguageDocument | undefined]>();
  #createLanguageDocument?: (document: TextDocument) => LanguageDocument;
  /** Cache of `fs_stat` results for `file:` paths, so module resolution can stay synchronous. */
  #statCache = new Map<string, FileSystemEntryType | 0>();
  /** `file:///node_modules/<pkg>` package roots known to exist (for real package type resolution). */
  #nodeModules = new Set<string>();

  constructor(
    ctx: monacoNS.worker.IWorkerContext<Host>,
    createData: WorkerCreateData,
    createLanguageDocument?: (document: TextDocument) => LanguageDocument,
  ) {
    this.#ctx = ctx;
    if (createData.fs) {
      const dirs = new Set<string>(["/"]);
      this.#fs = new Map(createData.fs.map((path) => {
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir) {
          dirs.add(dir);
        }
        return ["file://" + path, 1] as [string, FileSystemEntryType];
      }));
      for (const dir of dirs) {
        this.#fs.set("file://" + dir, 2);
      }
      createData.fs.length = 0;
      // seed node_modules package roots from the walked fs
      for (const path of this.#fs.keys()) {
        this.#trackNodeModule(path);
      }
    }
    this.#createLanguageDocument = createLanguageDocument;
  }

  get hasFileSystemProvider(): boolean {
    return !!this.#fs;
  }

  /** Track a path under `/node_modules` and register its package root. */
  #trackNodeModule(path: string): void {
    if (!path.startsWith("file:///node_modules/")) return;
    const rest = path.slice("file:///node_modules/".length);
    const parts = rest.split("/");
    if (parts.length === 0 || !parts[0] || parts[0].startsWith(".")) return;
    const root = parts[0].startsWith("@") && parts.length > 1 ? parts[0] + "/" + parts[1] : parts[0];
    this.#nodeModules.add("file:///node_modules/" + root);
  }

  /** The set of installed package roots (`file:///node_modules/<pkg>`). */
  get nodeModulePaths(): ReadonlySet<string> {
    return this.#nodeModules;
  }

  /** Synchronously-known fs entry type for a `file:` path (0 = known-missing, undefined = unknown). */
  fsKnownType(uri: string): FileSystemEntryType | 0 | undefined {
    return this.#statCache.get(uri) ?? this.#fs?.get(uri);
  }

  /** Whether a `file:` path is known to exist (via walked fs or a prior fs_stat). */
  hasFsPath(uri: string): boolean {
    return this.fsKnownType(uri) === 1;
  }

  /** Read a `file:` path's text through the host fs bridge (see client.createHost). */
  fsRead(uri: string): Promise<string> {
    return (this.#ctx.host as { fs_getContent: (u: string) => Promise<string> }).fs_getContent(uri);
  }

  /**
   * Read many `file:` paths in ONE bridge round-trip (see client.createHost).
   * Falls back to per-file reads if the host doesn't implement `fs_getContents`.
   * This is what makes large-package type resolution fast: the whole `.d.ts`
   * graph arrives at once instead of one RPC per file (which deadlocks Monaco's
   * single worker↔main channel for packages with thousands of type files).
   */
  async fsReadBatch(uris: string[]): Promise<(string | undefined)[]> {
    const host = this.#ctx.host as {
      fs_getContents?: (u: string[]) => Promise<(string | undefined)[]>;
      fs_getContent: (u: string) => Promise<string>;
    };
    if (typeof host.fs_getContents === "function") {
      return host.fs_getContents(uris);
    }
    return Promise.all(uris.map(async (u) => {
      try {
        return await host.fs_getContent(u);
      } catch {
        return undefined;
      }
    }));
  }

  /**
   * Stat a `file:` path asynchronously through the host fs bridge, caching the
   * result (1 = file, 2 = dir, 0 = missing) so subsequent synchronous lookups
   * via `fsKnownType` succeed. Returns the resolved entry type.
   */
  async fsProbe(uri: string): Promise<FileSystemEntryType | 0> {
    const known = this.#statCache.get(uri);
    if (known !== undefined) return known;
    try {
      // `fs_stat` is provided by the host fs bridge (see client.createHost).
      const stat: FileStat = await (this.#ctx.host as { fs_stat: (u: string) => Promise<FileStat> }).fs_stat(uri);
      this.#statCache.set(uri, stat.type);
      return stat.type;
    } catch {
      this.#statCache.set(uri, 0);
      return 0;
    }
  }

  get host() {
    return this.#ctx.host;
  }

  getMirrorModels() {
    return this.#ctx.getMirrorModels();
  }

  hasModel(fileName: string): boolean {
    return this.getModel(fileName) !== null;
  }

  getModel(fileName: string): monacoNS.worker.IMirrorModel | null {
    const models = this.getMirrorModels();
    for (let i = 0; i < models.length; i++) {
      const uri = models[i].uri;
      // Match the full URI form (`file:///x`) and the bare path form (`/x`)
      // that the TS language service uses when it asks for a resolved file.
      if (
        uri.toString() === fileName
        || uri.toString(true) === fileName
        || (uri.scheme === "file" && uri.path === fileName)
      ) {
        return models[i];
      }
    }
    return null;
  }

  getTextDocument(uri: string): TextDocument | null {
    const model = this.getModel(uri);
    if (!model) {
      return null;
    }
    const cached = this.#documentCache.get(uri);
    if (cached && cached[0] === model.version) {
      return cached[1];
    }
    const document = TextDocument.create(uri, "-", model.version, model.getValue());
    this.#documentCache.set(uri, [model.version, document, undefined]);
    return document;
  }

  getLanguageDocument(document: TextDocument): LanguageDocument {
    const { uri, version } = document;
    const cached = this.#documentCache.get(uri);
    if (cached && cached[0] === version && cached[2]) {
      return cached[2];
    }
    if (!this.#createLanguageDocument) {
      throw new Error("createLanguageDocument is not provided");
    }
    const languageDocument = this.#createLanguageDocument(document);
    this.#documentCache.set(uri, [version, document, languageDocument]);
    return languageDocument;
  }

  readDir(uri: string, extensions?: readonly string[]): [string, FileSystemEntryType][] {
    const entries: [string, FileSystemEntryType][] = [];
    if (this.#fs) {
      for (const [path, type] of this.#fs) {
        if (path.startsWith(uri)) {
          const name = path.slice(uri.length);
          if (!name.includes("/")) {
            if (type === 1) {
              if (!extensions || extensions.some((ext) => name.endsWith(ext))) {
                entries.push([name, 1]);
              }
            } else if (type === 2) {
              entries.push([name, 2]);
            }
          }
        }
      }
    }
    return entries;
  }

  /** Recursively list all file hrefs under a directory (uses the walked fs). */
  listFilesRecursive(uri: string, extensions?: readonly string[]): string[] {
    const out: string[] = [];
    if (!this.#fs) return out;
    const prefix = uri.endsWith("/") ? uri : uri + "/";
    for (const [path, type] of this.#fs) {
      if (type === 1 && path.startsWith(prefix)) {
        if (!extensions || extensions.some((ext) => path.endsWith(ext))) {
          out.push(path);
        }
      }
    }
    return out;
  }

  getFileSystemProvider() {
    if (this.#fs) {
      const host = this.#ctx.host;
      return {
        readDirectory: (uri: string): Promise<[string, FileSystemEntryType][]> => {
          return Promise.resolve(this.readDir(uri));
        },
        stat: (uri: string): Promise<{ type: FileSystemEntryType; ctime: number; mtime: number; size: number }> => {
          // @ts-expect-error `fs_stat` is defined in host
          return host.fs_stat(uri);
        },
        getContent: (uri: string, encoding?: string): Promise<string> => {
          // @ts-expect-error `fs_getContent` is defined in host
          return host.fs_getContent(uri);
        },
      };
    }
    return undefined;
  }

  // resolveReference implementes the `DocumentContext` interface
  resolveReference(ref: string, baseUrl: string): string | undefined {
    const { protocol, pathname, href } = new URL(ref, baseUrl);
    // if the file is not in the file system, return undefined
    if (protocol === "file:" && pathname !== "/" && this.#fs && !this.#fs.has(href.endsWith("/") ? href.slice(0, -1) : href)) {
      return undefined;
    }
    return href;
  }

  // #region methods used by the host

  async releaseDocument(uri: string): Promise<void> {
    this.#documentCache.delete(uri);
  }

  async fsNotify(kind: "create" | "remove" | "modify", path: string, type?: number): Promise<void> {
    const fs = this.#fs ?? (this.#fs = new Map());
    // Host watchers pass bare VFS paths (`/node_modules/...`); the walked fs
    // map is keyed by `file://` hrefs — normalize so create/remove stay coherent.
    const href = path.startsWith("file://")
      ? (path.length > "file:///".length && path.endsWith("/") ? path.slice(0, -1) : path)
      : "file://" + (path.startsWith("/") ? path : "/" + path);
    if (kind === "create") {
      if (type) {
        const entryType = type as FileSystemEntryType;
        fs.set(href, entryType);
        this.#statCache.set(href, entryType);
        this.#trackNodeModule(href);
        // Ensure parent directories exist so readDir / listFilesRecursive work
        // for packages installed after the initial workspace walk.
        let dir = href.slice(0, href.lastIndexOf("/"));
        while (dir.length > "file://".length) {
          if (fs.has(dir)) break;
          fs.set(dir, 2);
          const slash = dir.lastIndexOf("/");
          if (slash <= "file://".length) break;
          dir = dir.slice(0, slash);
        }
      }
    } else if (kind === "remove") {
      if (fs.get(href) === 1) {
        this.#documentCache.delete(href);
        this.#documentCache.delete(path);
      }
      fs.delete(href);
      this.#statCache.set(href, 0);
    }
  }

  // #endregion
}

export { TextDocument };
