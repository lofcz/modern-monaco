// Static file server for the Playwright e2e test.
//
// Serves three roots:
//   /modern-monaco/*  -> ../dist/*          (the locally built bundles)
//   /vendor/*         -> ../examples/vendor/* (vendored ESM deps, e.g. typescript)
//   /*                -> ../examples/*       (test harness pages)
//
// Everything is served locally so the test runs fully offline — no esm.sh.

const distDir = new URL("../dist/", import.meta.url);
const examplesDir = new URL("../examples/", import.meta.url);
const vendorDir = new URL("../examples/vendor/", import.meta.url);

function getContentType(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  if (pathname.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveFile(base: URL, pathname: string): Response | Promise<Response> {
  // Guard against path traversal above the served root.
  const fileUrl = new URL("." + pathname, base);
  if (!fileUrl.href.startsWith(base.href)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(fileUrl);
  return file.exists().then((exists) => {
    if (!exists) {
      return new Response("Not found: " + pathname, { status: 404 });
    }
    return new Response(file.stream(), {
      headers: {
        "content-type": getContentType(fileUrl.pathname),
        "cache-control": "no-cache, no-store, must-revalidate",
      },
    });
  });
}

const port = Number(process.env.E2E_PORT ?? 8123);

// The TS worker imports the bare specifier `typescript`, which a module Worker
// can't resolve via the page's import map (that would fail worker creation and
// silently fall back to the main thread). Rewrite it to the vendored ESM build
// so the worker loads with zero CDN and runs as a real Worker.
const TS_IMPORT = 'from "typescript"';
const TS_VENDORED = 'from "/vendor/typescript.mjs"';

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/modern-monaco/lsp/typescript/worker.mjs") {
      const file = Bun.file(new URL("lsp/typescript/worker.mjs", distDir));
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      const source = (await file.text()).replace(TS_IMPORT, TS_VENDORED);
      return new Response(source, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache, no-store, must-revalidate",
        },
      });
    }
    if (pathname === "/modern-monaco" || pathname.startsWith("/modern-monaco/")) {
      const rest = pathname.slice("/modern-monaco".length) || "/index.mjs";
      return serveFile(distDir, rest);
    }
    if (pathname.startsWith("/vendor/")) {
      return serveFile(vendorDir, pathname.slice("/vendor".length));
    }
    return serveFile(examplesDir, pathname === "/" ? "/index.html" : pathname);
  },
});

console.log(`e2e server listening on ${server.url}`);
