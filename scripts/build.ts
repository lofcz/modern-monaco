import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { grammars as shikiGrammars, injections } from "../node_modules/tm-grammars/index.js";
import { themes as shikiThemes } from "../node_modules/tm-themes/index.js";
import { wasmBinary } from "../node_modules/@shikijs/engine-oniguruma/dist/wasm-inlined.mjs";

const bundleTypescriptLibs = async () => {
  const glob = new Bun.Glob("node_modules/typescript/lib/lib.*.d.ts");
  const dtsFiles = [...glob.scanSync()];
  dtsFiles.sort();
  // Bun.Glob on Windows yields backslash paths; basename via `/` split alone
  // leaves keys like `node_modules\typescript\lib\lib.dom.d.ts`, which the
  // worker never finds (it looks up `lib.dom.d.ts`). Normalize separators.
  const libs = Object.fromEntries(
    await Promise.all(
      dtsFiles.map(async (filePath) => {
        const name = filePath.replaceAll("\\", "/").split("/").at(-1)!;
        return [name, await Bun.file(filePath).text()] as const;
      }),
    ),
  );
  await Bun.write(
    "dist/lsp/typescript/libs.mjs",
    "export default " + JSON.stringify(libs, undefined, 2),
  );
};
const modifyEditorCore = async () => {
  const js = await Bun.file("dist/editor-core.mjs").text();
  const ret = await esbuild.build({
    entryPoints: ["dist/editor-core.css"],
    minify: true,
    write: false,
  });
  const css = ret.outputFiles[0].text;
  const addonCss =
    `.monaco-inputbox input{outline:1px solid var(--vscode-focusBorder)} .rename-box input{color:inherit;font-family:inherit;font-size:100%;}.monaco-editor .rename-box .rename-input-with-button{width:auto}`;
  await Bun.write("dist/editor-core.mjs", js + "\nexport const cssBundle = " + JSON.stringify(css + addonCss));
};
const copyDts = (...files: [src: string, dest: string][]) => {
  return Promise.all(files.map(([src, dest]) => Bun.$`cp node_modules/${src} types/${dest}`));
};
const tmDefine = () => {
  const keys = ["name", "scopeName", "aliases", "embedded", "embeddedIn", "injectTo"];

  // add aliases for javascript and typescript
  shikiGrammars.find((g) => g.name === "javascript")!.aliases = ["js", "mjs", "cjs"];
  shikiGrammars.find((g) => g.name === "typescript")!.aliases = ["ts", "mts", "cts"];

  // update embedded grammars
  shikiGrammars.find((g) => g.name === "html")!.embedded = ["json", "css", "javascript"];
  for (const id of ["javascript", "typescript", "jsx", "tsx"]) {
    shikiGrammars.find((v) => v.name === id)!.embedded = ["html", "css"];
  }

  const grammars = shikiGrammars.map((v) => Object.fromEntries(keys.map((k) => [k, v[k as keyof typeof v]])));
  const injections_grammars = injections.map((v) => Object.fromEntries(keys.map((k) => [k, v[k as keyof typeof v]])));

  return {
    SHIKI_THEMES: JSON.stringify(shikiThemes.map((v) => v.name)),
    SHIKI_GRAMMARS: JSON.stringify([...grammars, ...injections_grammars]),
  };
};
const buildEditorCore = async () => {
  await runBuild([
    "src/editor-core.ts",
    "src/editor-worker.ts",
    "src/editor-worker-main.ts",
  ]);
  await modifyEditorCore();
  await Bun.$`rm -f dist/editor-core.css dist/editor-core.css.map`;
};
const buildDist = async () => {
  await runBuild([
    "src/cache.ts",
    "src/index.ts",
    "src/core.ts",
    "src/shiki-wasm.ts",
    "src/util.ts",
    "src/workspace.ts",
    "src/ssr/index.ts",
    "src/ssr/workerd.ts",
    "src/lsp/index.ts",
    "src/lsp/css/setup.ts",
    "src/lsp/css/worker.ts",
    "src/lsp/html/setup.ts",
    "src/lsp/html/worker.ts",
    "src/lsp/json/setup.ts",
    "src/lsp/json/worker.ts",
    "src/lsp/client.ts",
    "src/lsp/typescript/setup.ts",
    "src/lsp/typescript/worker.ts",
  ]);
  await runBuild(["src/shiki.ts"], tmDefine());
};
const buildTypes = async () => {
  await copyDts(
    ["monaco-editor-core/esm/vs/editor/editor.api.d.ts", "monaco.d.ts"],
    ["vscode-json-languageservice/lib/esm/jsonSchema.d.ts", "jsonSchema.d.ts"],
  );
  await Bun.write(
    "types/textmate.d.ts",
    [
      "export type TextmateThemeName = " + shikiThemes.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
      "export type TextmateGrammarName = " + shikiGrammars.map((v) => JSON.stringify(v.name)).join(" | ") + ";",
    ].join("\n"),
  );
};
const runBuild = (entryPoints: string[], define?: Record<string, string>) => {
  return esbuild.build({
    target: "es2022",
    format: "esm",
    platform: "browser",
    outdir: "dist",
    bundle: true,
    treeShaking: true,
    logLevel: "info",
    define,
    loader: {
      ".ttf": "dataurl",
    },
    outExtension: {
      ".js": ".mjs",
    },
    plugins: [
      {
        name: "external",
        setup(build: any) {
          // Shim Node builtins that the bundled TypeScript references at init.
          // esbuild's platform:"browser" otherwise disables them (empty module),
          // and `os.platform()` etc. throw, killing the worker. Mapped here to
          // a virtual shim namespace handled by onLoad below.
          const NODE_BUILTINS = new Set(["os", "fs", "path", "crypto", "node:os", "node:fs", "node:path", "node:crypto"]);
          build.onResolve({ filter: /.*/ }, (args: { path: string; resolveDir: string }) => {
            if (NODE_BUILTINS.has(args.path)) {
              return { path: args.path.replace(/^node:/, ""), namespace: "node-shim" };
            }
            if (args.path.endsWith(".wasm")) {
              return {
                path: args.path,
                external: true,
              };
            }
            if (
              args.path.endsWith(".js") && args.path.startsWith(".")
              // Normalize to a real filesystem path: `URL.pathname` keeps the
              // POSIX form ("/C:/...") which never matches esbuild's Windows
              // resolveDir ("C:\..."), silently breaking the external rewrite.
              && args.resolveDir.startsWith(fileURLToPath(import.meta.resolve("../src")))
            ) {
              return {
                path: args.path.replace(".js", ".mjs"),
                external: true,
              };
            }
            return {};
          });
          build.onLoad({ filter: /.*/, namespace: "node-shim" }, (args: { path: string }) => {
            const name = args.path;
            // CommonJS shims (module.exports) so TypeScript's `require("os")`
            // interops to the object itself, not `{ default: ... }`.
            const shims: Record<string, string> = {
              os: `module.exports = { platform: () => "browser", EOL: "\\n", tmpdir: () => "/tmp" };`,
              fs: `module.exports = { realpathSync: Object.assign((p) => p, { native: (p) => p }), statSync: () => { throw new Error("fs.statSync unavailable in browser"); }, existsSync: () => false, readFileSync: () => { throw new Error("fs.readFileSync unavailable in browser"); }, writeFileSync: () => {}, directoryExists: () => false, getDirectories: () => [], readDirectory: () => [] };`,
              path: `module.exports = { join: (...p) => p.filter(Boolean).join("/"), dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/", resolve: (...p) => p.filter(Boolean).join("/"), basename: (p) => p.slice(p.lastIndexOf("/") + 1), extname: (p) => { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i); }, sep: "/", delimiter: ":" };`,
              crypto: `module.exports = undefined;`,
            };
            return { contents: shims[name] ?? "module.exports = {};", loader: "js" };
          });
        },
      },
    ],
    entryPoints,
  });
};
const debounce = (fn: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
};

export async function build(dev?: boolean) {
  // clean previous build
  await Bun.$`rm -rf dist`;

  await buildEditorCore();
  await buildDist();
  await buildTypes();
  await bundleTypescriptLibs();
  await Bun.write("dist/onig.wasm", wasmBinary);

  dev && watch();
}

export async function watch() {
  const queueBuildDist = debounce(() => buildDist().catch(err => console.error(err)), 500);
  const queueBuildEditorCore = debounce(() => buildEditorCore().catch(err => console.error(err)), 500);
  const watcher = fs.watch("src", { recursive: true });
  console.log("Watching for file changes...");
  for await (const { filename } of watcher) {
    if (filename === null) continue;
    if (filename.endsWith("/src/editor-core.ts") || filename.endsWith("/src/editor-worker.ts")) {
      queueBuildEditorCore();
    } else {
      queueBuildDist();
    }
  }
}

if (import.meta.main) {
  build(process.argv.includes("--watch"));
}
