import { expect, test } from "@playwright/test";

test("awaits a delayed declaration graph with extensionless sources, mapped bare imports and directory exports", async ({ context, page }) => {
  const requests: string[] = [];
  const declarations: Record<string, string> = {
    "/type-acquisition/store/index.d.ts": 'export { useStore } from "./react";',
    "/type-acquisition/store/react.d.ts": 'import type { StoreApi } from "store-core"; export declare const useStore: StoreApi<{count: number}>;',
    "/type-acquisition/core": "export {};",
    "/type-acquisition/core/index.d.ts": 'export { StoreApi } from "./vanilla/";',
    "/type-acquisition/core/vanilla/index.d.ts": "export interface StoreApi<T> { getState(): T; }",
  };
  await context.route("**/type-acquisition/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    const body = declarations[pathname];
    if (body === undefined) return route.fulfill({ status: 404, body: "Not found" });
    if (pathname.endsWith("/vanilla/index.d.ts")) await new Promise((resolve) => setTimeout(resolve, 250));
    return route.fulfill({
      body,
      headers: {
        "content-type": pathname.endsWith(".d.ts") ? "application/typescript" : "application/javascript",
        ...(pathname === "/type-acquisition/core" ? { "x-typescript-types": "/type-acquisition/core/index.d.ts" } : {}),
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-type-acquisition.html");
  await page.waitForFunction(() => (window as any).__e2e);
  await page.evaluate(() => (window as any).__e2e.settle());
  expect(requests).toEqual(expect.arrayContaining(Object.keys(declarations)));
  expect(requests).not.toContain("/type-acquisition/core.d.ts");
  expect(requests).not.toContain("/type-acquisition/core/vanilla/.d.ts");
  expect(await page.evaluate(() => {
    const { monaco } = (window as any).__e2e;
    return monaco.editor.getModelMarkers({}).map((marker: any) => ({
      file: marker.resource.path, code: String(marker.code?.value ?? marker.code),
    }));
  })).toEqual([{ file: "/main.ts", code: "2322" }]);
  expect(errors).toEqual([]);
});

test("resolves a previously missing extensionless import after its source model arrives", async ({ page }) => {
  await page.goto("/e2e-type-acquisition.html?late");
  await page.waitForFunction(() => (window as any).__e2e);
  await page.evaluate(() => (window as any).__e2e.settle());
  await expect.poll(() => page.evaluate(() => {
    const { monaco } = (window as any).__e2e;
    return monaco.editor.getModelMarkers({}).map((marker: any) => String(marker.code?.value ?? marker.code));
  })).toContainEqual(expect.stringMatching(/^(2307|7016)$/));
  await page.evaluate(async () => {
    const { monaco, workspace } = (window as any).__e2e;
    await workspace.fs.writeFile("late.ts", "export const count: number = 1;");
    monaco.editor.createModel("export const count: number = 1;", "typescript", monaco.Uri.file("late.ts"));
    await (window as any).__e2e.settle();
  });
  expect(await page.evaluate(() => {
    const { monaco } = (window as any).__e2e;
    return monaco.editor.getModelMarkers({}).map((marker: any) => String(marker.code?.value ?? marker.code));
  })).toEqual(["2322"]);
});

test("refreshes added and changed package mappings in an already open editor", async ({context,page})=>{
 await context.route('**/late-package-v*.d.ts',route=>route.fulfill({contentType:'application/typescript',body:route.request().url().includes('v1')?'export const count: number;':'export const count: string;'}));
 await page.goto('/e2e-type-acquisition.html?late');
 await page.waitForFunction(()=>(window as any).__e2e);
 await page.evaluate(async()=>{
  const {monaco}=(window as any).__e2e;
  monaco.editor.getModel(monaco.Uri.file('main.ts')).setValue('import {count} from "new-package"; export const result: string = count;');
  await (window as any).__e2e.settle();
 });
 const codes=()=>page.evaluate(()=>(window as any).__e2e.monaco.editor.getModelMarkers({}).filter((m:any)=>m.resource.path==='/main.ts').map((m:any)=>String(m.code?.value??m.code)));
 await expect.poll(codes).toContain('2307');
 await page.evaluate(async()=>{
  const {updateImportMap}=await import('/modern-monaco/lsp/typescript/setup.mjs');
  await updateImportMap({imports:{'new-package':location.origin+'/late-package-v1.d.ts'}});
  await (window as any).__e2e.settle();
 });
 await expect.poll(codes).toEqual(['2322']);
 await page.evaluate(async()=>{
  const {updateImportMap}=await import('/modern-monaco/lsp/typescript/setup.mjs');
  await updateImportMap({imports:{'new-package':location.origin+'/late-package-v2.d.ts'}});
  await (window as any).__e2e.settle();
 });
 await expect.poll(codes).toEqual([]);
});
