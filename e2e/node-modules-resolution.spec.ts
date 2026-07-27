import { expect, test } from "@playwright/test";

/**
 * e2e: bare-import type resolution from the real installed `/node_modules`
 * (the new `resolution: "node_modules"` mode) — no importmap, no esm.sh.
 *
 * The harness page installs a minimal `react` package into the workspace VFS
 * and opens `src/App.tsx`, which imports `react` and `react/jsx-runtime`.
 * The TypeScript worker must read those real `.d.ts` files over the workspace
 * FS bridge and produce no "cannot find module" errors.
 */
test("resolves react + react/jsx-runtime types from /node_modules (no esm.sh)", async ({ page }) => {
  // Type-resolution would fetch `.d.ts`/packages from esm.sh in importmap mode.
  // In node_modules mode it must not — record any such fetch as a violation.
  const typeCdnRequests: string[] = [];
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.host.includes("esm.sh") && (u.pathname.includes("react") || u.pathname.endsWith(".d.ts") || u.pathname.includes("typescript"))) {
        typeCdnRequests.push(req.url());
      }
    } catch {
      // ignore non-URL requests (data:, blob:)
    }
  });

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto("/e2e-node-modules-resolution.html");

  // The page sets window.__e2eStatus = "ready" once init() + model open settle.
  await page.waitForFunction(() => (window as any).__e2eStatus === "ready", null, { timeout: 60_000 });

  // The TS LSP registers lazily on first use of the `tsx` language (slightly
  // after `ready`). Wait until the worker is live before asserting on it.
  await page.waitForFunction(() => "__monacoLanguageWorker" in globalThis, null, { timeout: 30_000 });

  // Poll semantic markers until the TS worker has analyzed the open model.
  // Assert no "cannot find module" errors for react / react/jsx-runtime.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { monaco, editor } = (window as any).__e2e;
          const model = editor.getModel();
          if (!model) return { ready: false as const };
          const markers = monaco.editor.getModelMarkers({ resource: model.uri });
          const moduleErrors = markers.filter((m: any) => {
            const text = `${m.message}`.toLowerCase();
            return (
              (m.code === "2307" || m.code === "2792" || /cannot find module|has no default export|jsx-runtime/.test(text))
              && m.severity >= monaco.MarkerSeverity.Error
            );
          });
          return {
            ready: true as const,
            scheme: model.uri.scheme,
            allMarkers: markers.map((m: any) => ({ code: m.code, message: m.message, severity: m.severity })),
            moduleErrors: moduleErrors.map((m: any) => `${m.code}: ${m.message}`),
          };
        }),
      { timeout: 45_000, intervals: [500, 1000, 2000] },
    )
    .toMatchObject({ ready: true, scheme: "file", moduleErrors: [] });

  // Positive proof the imported types are actually driving IntelliSense: call
  // the TS worker's hover + completion directly and assert on real output.
  // Poll because the program needs a moment to load the resolved .d.ts files.
  const queryIntellisense = () =>
    page.evaluate(async () => {
      const { editor } = (window as any).__e2e;
      const model = editor.getModel();
      const uri = model.uri.toString();
      const text: string = model.getValue();
      const worker = (globalThis as any).__monacoLanguageWorker;
      if (!worker) return { hoverUseState: "", labels: [] as string[] };
      const proxy = await worker.withSyncedResources([model.uri]);

      const toLspPos = (offset: number) => {
        const p = model.getPositionAt(offset);
        return { line: p.lineNumber - 1, character: p.column - 1 }; // LSP is 0-based
      };
      const offsetOf = (needle: string, occurrence = 0, delta = 0) => {
        let idx = -1;
        for (let i = 0; i <= occurrence; i++) idx = text.indexOf(needle, idx + 1);
        return idx < 0 ? -1 : idx + needle.length + delta;
      };
      const fmtHover = (h: any): string => !h
        ? ""
        : Array.isArray(h.contents)
        ? h.contents.map((c: any) => c.value ?? c).join("\n")
        : (h.contents?.value ?? h.contents ?? "");

      // Hover on the `useState` import specifier (resolves to index.d.ts).
      const hoverUseState = fmtHover(await proxy.doHover(uri, toLspPos(offsetOf("useState", 0, 0))));
      // Completion after `React.` in `React.version`.
      const complete = await proxy.doComplete(uri, toLspPos(offsetOf("React.", 0, 0)));
      const labels = (complete?.items ?? []).map((i: any) => (typeof i.label === "string" ? i.label : i.label?.label));

      return { hoverUseState, labels };
    });

  await expect
    .poll(queryIntellisense, { timeout: 30_000, intervals: [500, 1000, 2000] })
    .toMatchObject({
      // Hover on the `useState` import must surface the exact signature declared
      // in /node_modules/react/index.d.ts (proves the .d.ts was actually read).
      hoverUseState: expect.stringContaining("function useState"),
      // Autocomplete after `React.` must include members from index.d.ts.
      labels: expect.arrayContaining(["version", "createElement", "useState"]),
    });

  const intellisense = await queryIntellisense();
  expect(intellisense.hoverUseState).toContain("initial");

  // No CDN / esm.sh must have been contacted for type resolution.
  expect(typeCdnRequests, `unexpected type CDN requests:\n${typeCdnRequests.join("\n")}`).toEqual([]);

  // Surface hard failures, but don't fail the test on benign console noise.
  expect(pageErrors).toEqual([]);
});
