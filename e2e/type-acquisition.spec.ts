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

test("opens .js-specified TypeScript sources and JSON imports in the background", async ({ page }) => {
  await page.goto("/e2e-type-acquisition.html?local");
  await page.waitForFunction(() => (window as any).__e2e);
  const markers = () => page.evaluate(async () => {
    await (window as any).__e2e.settle();
    const { monaco } = (window as any).__e2e;
    return monaco.editor.getModelMarkers({}).filter((m: any) => m.resource.path === "/main.ts")
      .map((m: any) => String(m.code?.value ?? m.code) + ":" + m.startColumn).sort();
  });
  // Exactly the two deliberate string/number mismatches; no 2307 for either import.
  await expect.poll(markers).toEqual(expect.arrayContaining([expect.stringMatching(/^2322:/), expect.stringMatching(/^2322:/)]));
  expect((await markers()).every((m) => m.startsWith("2322:"))).toBe(true);
  expect(await markers()).toHaveLength(2);
});

test("queries a workspace module's API without opening editor models", async ({ page }) => {
  await page.goto("/e2e-type-acquisition.html?api");
  await page.waitForFunction(() => (window as any).__e2e);
  const q = (specifier: string, options?: object) =>
    page.evaluate(async ([specifier, options]) => {
      const { queryApiSymbols } = await import("/modern-monaco/lsp/typescript/setup.mjs");
      return queryApiSymbols(specifier, options);
    }, [specifier, options] as const);
  const before = await page.evaluate(() => (window as any).__e2e.monaco.editor.getModels().map((m: any) => m.uri.path).sort());

  const all = await q("./lib/api");
  expect(all).toMatchObject({ status: "resolved", total: 5, truncated: false });
  expect(all.exports.map((e: any) => e.name).sort()).toEqual(["Camera", "Context", "Options", "Shapes", "light"]);

  const first = await q("./lib/api", { limit: 2 });
  expect(first).toMatchObject({ truncated: true, nextOffset: 2 });
  const rest = await q("./lib/api", { limit: 10, offset: 2 });
  expect(rest.nextOffset).toBeUndefined();
  expect(new Set([...first.exports, ...rest.exports].map((e: any) => e.name)).size).toBe(5);
  expect((await q("./lib/api", { filter: "opt" })).exports).toEqual([{ name: "Options" }]);

  const camera = await q("./lib/api", { symbol: "Camera" });
  expect(camera.documentation).toMatch(/test camera/);
  expect(camera.members.map((m: any) => m.name).sort()).toEqual(["fov", "update"]);
  const update = await q("./lib/api", { symbol: "Camera.update" });
  expect(update.signatures[0]).toMatch(/delta: number/);
  expect(update.documentation).toBe("Advance time.");
  expect(update.definitions[0]).toMatchObject({ uri: "file:///lib/base.ts" });

  const light = await q("./lib/api", { symbol: "light" });
  expect(light.signatures).toHaveLength(2);
  expect(light.tags[0].name).toBe("deprecated");
  expect((await q("./lib/api", { symbol: "Context.options.intensity" })).type).toBe("number");
  expect((await q("./lib/api", { symbol: "Shapes.Box.width" })).type).toBe("number");
  expect((await q("./lib/api", { symbol: "Nope" })).status).toBe("not-found");
  expect((await q("./lib/api", { symbol: "Camera.nope" })).status).toBe("not-found");
  const missing = await q("./does-not-exist");
  expect(missing.status).toBe("unresolved");
  expect(missing.diagnostics.join("\n")).toMatch(/does-not-exist/);

  // Background opening may add source models; the query file itself must never become one.
  const after = await page.evaluate(() => (window as any).__e2e.monaco.editor.getModels().map((m: any) => m.uri.path));
  expect(after.some((p: string) => p.includes("api_query"))).toBe(false);
  expect(after).toEqual(expect.arrayContaining(before));
  // Files opened for the query are checked like any import: no errors once their imports load.
  await expect.poll(() => page.evaluate(() => (window as any).__e2e.monaco.editor.getModelMarkers({})
    .filter((m: any) => m.severity >= 4).map((m: any) => m.resource.path + ":" + m.message)), { timeout: 5000 }).toEqual([]);
});

test("queries an import-mapped CDN package's API after acquiring its declarations", async ({ context, page }) => {
  await context.route("**/api-pkg/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api-pkg/index.d.ts"
      ? 'export { Store } from "./store";'
      : path === "/api-pkg/store.d.ts" ? "/** A store. */ export declare class Store<T> { get(): T; set(value: T): void; }" : undefined;
    return route.fulfill({ status: body ? 200 : 404, body: body ?? "Missing", contentType: "application/typescript" });
  });
  await page.goto("/e2e-type-acquisition.html?api");
  await page.waitForFunction(() => (window as any).__e2e);
  const result = await page.evaluate(async () => {
    const { queryApiSymbols, updateImportMap } = await import("/modern-monaco/lsp/typescript/setup.mjs");
    await updateImportMap({ imports: { "api-pkg": location.origin + "/api-pkg/index.d.ts" } });
    return queryApiSymbols("api-pkg", { symbol: "Store" });
  });
  expect(result).toMatchObject({ status: "resolved", documentation: "A store." });
  expect(result.members.map((m: any) => m.name)).toEqual(["get", "set"]);
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

// CDN and package names are fixtures: the same resolver must work for any
// library and both named and namespace imports, without host-app mappings.
for (const external of [false, true]) {
 test(`acquires ${external ? 'DefinitelyTyped' : 'bundled'} declarations without a CDN header`, async ({context,page})=>{
  const seen:string[]=[];
  const root='/@scope/widgets@2.4.3';
  const types='/@types/scope__widgets@2';
  const files:Record<string,string>={
   [root]:'export class Widget { constructor() {} }',
   [root+'/package.json']:JSON.stringify({name:'@scope/widgets',version:'2.4.3',...(external?{}:{exports:{'.':{types:'./types/index.d.ts'}}})}),
   [(external?types:root+'/types')+'/index.d.ts']:'export { Widget } from "./Widget.js"; export type { Options } from "./options.mjs";',
   [(external?types:root+'/types')+'/Widget.d.ts']:'export declare class Widget { value: number; setValue(value: number): void; }',
   [(external?types:root+'/types')+'/options.d.mts']:'export interface Options { enabled: boolean; }',
   ...(external?{[types+'/package.json']:JSON.stringify({name:'@types/scope__widgets',version:'2.4.9',types:'index.d.ts'})}:{}),
  };
  await context.route('**/@scope/**',respond);await context.route('**/@types/**',respond);
  async function respond(route:any){const path=new URL(route.request().url()).pathname;seen.push(path);const body=files[path];await route.fulfill({status:body===undefined?404:200,body:body??'Missing',contentType:path.endsWith('.json')?'application/json':/\.d\.(m|c)?ts$/.test(path)?'application/typescript':'application/javascript'});}
  await page.goto('/e2e-type-acquisition.html?late');await page.waitForFunction(()=>(window as any).__e2e);
  await page.evaluate(()=>(window as any).__e2e.settle());
  await page.evaluate(async(root)=>{
   const {monaco,workspace}=(window as any).__e2e;
   const {updateImportMap}=await import('/modern-monaco/lsp/typescript/setup.mjs');
   await updateImportMap({imports:{widgets:location.origin+root}});
   const source = 'import * as W from "widgets"; import { Widget } from "widgets"; const first: W.Widget = new W.Widget(); const second: Widget = first; second.setValue(2); export const options: W.Options = { enabled: true }; export const wrong: string = first.value;';
   await workspace.fs.writeFile('main.ts',source);
   monaco.editor.getModel(monaco.Uri.file('main.ts')).setValue(source);
   await (window as any).__e2e.settle();
  },root);
  const markers=()=>page.evaluate(async()=>{ await (window as any).__e2e.settle(); return (window as any).__e2e.monaco.editor.getModelMarkers({}).filter((m:any)=>m.resource.path==='/main.ts').map((m:any)=>({code:String(m.code?.value??m.code),message:m.message})); });
  await expect.poll(markers).toEqual([{code:'2322',message:"Type 'number' is not assignable to type 'string'."}]);
  expect(seen).not.toContain(expect.stringContaining('.js.d.ts'));
  expect(seen).not.toContain(expect.stringContaining('.mjs.d.ts'));
  if(!external)expect(seen.some(path=>path.startsWith('/@types/'))).toBe(false);
 });
}
