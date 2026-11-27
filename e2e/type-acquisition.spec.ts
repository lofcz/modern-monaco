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
