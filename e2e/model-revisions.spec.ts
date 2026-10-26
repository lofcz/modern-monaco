import { expect, test } from "@playwright/test";

test("diagnostics track repairs and newly introduced errors without adding models", async ({ page }) => {
  await page.goto("/e2e-node-modules-resolution.html");
  await page.waitForFunction(() => (window as any).__e2eStatus === "ready");
  const check = (source: string) => page.evaluate(async (source) => {
    const { monaco, editor } = (window as any).__e2e;
    const model = editor.getModel();
    model.setValue(source);
    const { waitForTypeResolution } = await import("/modern-monaco/lsp/typescript/setup.mjs");
    await waitForTypeResolution([model.uri]);
    return monaco.editor.getModelMarkers({ resource: model.uri })
      .map((marker: any) => String(marker.code?.value ?? marker.code));
  }, source);

  expect(await check("export const value = { key: 1, key: 2 };\n")).toEqual(["1117"]);
  expect(await check("export const value = { key: 1 };\n")).toEqual([]);
  expect(await check("export const value: number = 'wrong';\n")).toEqual(["2322"]);
  expect(await check("export const value: number = 1;\n")).toEqual([]);
});
