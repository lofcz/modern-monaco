// [patch-1] replace the default command history storage (which is in-memory) of Monaco Editor with a browser localStorage-based one
const commandHistoryStorageJs = `{
  get: (key, _scope, defaultValue) => localStorage.getItem('monaco:' + key) ?? defaultValue,
  getNumber: (key, _scope, defaultValue) => Number(localStorage.getItem('monaco:' + key) ?? defaultValue) || defaultValue,
  store: (key, value) => localStorage.setItem('monaco:' + key, String(value)),
  onWillSaveState: (callback) => {
    window.addEventListener('beforeunload', () => {
      callback({ reason: WillSaveStateReason.SHUTDOWN });
    });
  },
};
`;
{
  const path = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/commandsQuickAccess.js";
  const js = await Bun.file(path).text();
  const arr = js.split("this.storageService = storageService;");
  if (arr.length === 2) {
    await Bun.write(path, arr[0] + "// Added by modern-monaco\nthis.storageService = " + commandHistoryStorageJs + arr[1]);
    console.log("[patch-1]", path.slice("node_modules/".length));
  }
}

// [patch-2] add keybindings for the quick pick navigation on macOS
const registerQuickPickCommandAndKeybindingRulesJS = `
// Added by modern-monaco
if (isMacintosh) {
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Next', primary: 256 /* KeyMod.WinCtrl */ + 44 /* KeyCode.N */, handler: focusHandler(QuickPickFocus.Next) });
  registerQuickPickCommandAndKeybindingRule({ id: 'quickInput.Previous', primary: 256 /* KeyMod.WinCtrl */ + 46 /* KeyCode.P */, handler: focusHandler(QuickPickFocus.Previous) });
}
`;
{
  const path = "node_modules/monaco-editor-core/esm/vs/platform/quickinput/browser/quickInputActions.js";
  const js = await Bun.file(path).text();
  if (!js.includes(registerQuickPickCommandAndKeybindingRulesJS)) {
    await Bun.write(path, js + registerQuickPickCommandAndKeybindingRulesJS);
    console.log("[patch-2]", path.slice("node_modules/".length));
  }
}

// [patch-3] fix type definitions for createModel and getModel to accept `string | URL | Uri` type for the `uri` parameter
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/editor.api.d.ts";
  const diffs = [
    [
      "export function createModel(value: string, language?: string, uri?: Uri): ITextModel;",
      "export function createModel(value: string, language?: string, uri?: string | URL | Uri): ITextModel;",
    ],
    [
      "export function getModel(uri: Uri): ITextModel | null;",
      "export function getModel(uri: string | URL | Uri): ITextModel | null;",
    ],
  ];
  const addon = "\nexport * from './vscode';\n";
  let dts = await Bun.file(path).text();
  let patched = false;
  for (const [search, replace] of diffs) {
    if (!dts.includes(replace)) {
      dts = dts.replace(search, replace);
      patched = true;
    }
  }
  if (!dts.includes(addon)) {
    const pathOrgi = "types/vscode.d.ts";
    const pathDest = "node_modules/monaco-editor-core/esm/vs/editor/vscode.d.ts";
    await Bun.write(pathDest, (await Bun.file(pathOrgi).text()).replace("./monaco.d.ts", "./editor.api.d.ts"));
    dts += addon;
    patched = true;
  }
  if (patched) {
    await Bun.write(path, dts);
    console.log("[patch-3]", path.slice("node_modules/".length));
  }
}

// [patch-4] fix the issue of `maxDigitWidth` not being set correctly in SSR mode
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/common/config/editorOptions.js";
  const js = await Bun.file(path).text();
  const search = "maxDigitWidth: env.fontInfo.maxDigitWidth,";
  const replace = "maxDigitWidth: globalThis.__monaco_maxDigitWidth || env.fontInfo.maxDigitWidth,";
  if (!js.includes(replace)) {
    await Bun.write(path, js.replace(search, replace));
    console.log("[patch-4]", path.slice("node_modules/".length));
  }
}

// [patch-5] fix folding icon size
{
  const path = "node_modules/monaco-editor-core/esm/vs/editor/contrib/folding/browser/folding.css";
  const css = await Bun.file(path).text();
  const search = "font-size: 140%;";
  const replace = "font-size: 100%;";
  if (css.includes(search)) {
    await Bun.write(path, css.replace(search, replace));
    console.log("[patch-5]", path.slice("node_modules/".length));
  }
}

// [patch-6] BrowserClipboardService.readResources() awaits navigator.clipboard.read()
// for a vscode-only URI-list mime type. When clipboard-read permission is
// "prompt" (the Chrome default for top-level documents), that promise never
// settles until the user answers a prompt that often never appears for this
// background call — and CopyPasteController.mergeInDataFromCopy hangs forever
// after already claiming the paste event. Standalone embeds only need the
// in-memory resources list; skip the async clipboard probe.
{
  const path =
    "node_modules/monaco-editor-core/esm/vs/platform/clipboard/browser/clipboardService.js";
  const js = await Bun.file(path).text();
  const search = `async readResources() {
        // Guard access to navigator.clipboard with try/catch
        // as we have seen DOMExceptions in certain browsers
        // due to security policies.
        try {
            const items = await getActiveWindow().navigator.clipboard.read();
            for (const item of items) {
                if (item.types.includes(\`web \${vscodeResourcesMime}\`)) {
                    const blob = await item.getType(\`web \${vscodeResourcesMime}\`);
                    const resources = JSON.parse(await blob.text()).map(x => URI.from(x));
                    return resources;
                }
            }
        }
        catch (error) {
            // Noop
        }
        const resourcesStateHash = await this.computeResourcesStateHash();
        if (this.resourcesStateHash !== resourcesStateHash) {
            this.clearResourcesState(); // state mismatch, resources no longer valid
        }
        return this.resources;
    }`;
  const replace = `async readResources() {
        // Patched by modern-monaco: never call navigator.clipboard.read() here.
        // That API gates on clipboard-read permission and can hang indefinitely
        // at "prompt", which freezes paste after CopyPasteController claims the
        // event. In-memory resources are enough for standalone embeds.
        const resourcesStateHash = await this.computeResourcesStateHash();
        if (this.resourcesStateHash !== resourcesStateHash) {
            this.clearResourcesState(); // state mismatch, resources no longer valid
        }
        return this.resources;
    }`;
  if (js.includes(search) && !js.includes("Patched by modern-monaco: never call navigator.clipboard.read()")) {
    await Bun.write(path, js.replace(search, replace));
    console.log("[patch-6]", path.slice("node_modules/".length));
  } else if (!js.includes("Patched by modern-monaco: never call navigator.clipboard.read()")) {
    console.warn("[patch-6] clipboardService.js readResources shape changed — update patch");
  }
}

// [patch-7] Context-menu Paste requires text focus, but opening the context menu
// blurs the textarea (widget focus remains). Upstream then returns false and the
// generic-dom fallback's execCommand('paste') is a no-op in modern Chrome — so
// "Paste" in the menu silently does nothing. Re-focus before the web clipboard
// fallback runs.
{
  const path =
    "node_modules/monaco-editor-core/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
  let js = await Bun.file(path).text();
  const focusSearch =
    `// Only if editor text focus (i.e. not if editor has widget focus).
        const focusedEditor = codeEditorService.getFocusedCodeEditor();
        if (focusedEditor && focusedEditor.hasModel() && focusedEditor.hasTextFocus()) {`;
  const focusReplace =
    `// Patched by modern-monaco: accept widget focus too (context menu).
        const focusedEditor = codeEditorService.getFocusedCodeEditor();
        if (focusedEditor && focusedEditor.hasModel()) {
            if (!focusedEditor.hasTextFocus()) {
                focusedEditor.focus();
            }`;
  if (js.includes(focusSearch)) {
    js = js.replace(focusSearch, focusReplace);
    console.log("[patch-7a]", path.slice("node_modules/".length));
  } else if (!js.includes("Patched by modern-monaco: accept widget focus too")) {
    console.warn("[patch-7a] clipboard.js PasteAction focus check changed — update patch");
  }
  // BrowserClipboardService.triggerPaste() always returns undefined. Upstream
  // only then falls back to clipboardService.readText() when `isWeb` — but a
  // process polyfill (browser-vite) can make isWeb false. Always use the web
  // fallback whenever the Clipboard API exists.
  const webSearch = `if (platform.isWeb) {
                logService.trace('registerExecCommandImpl (Paste handling on web)');
                // Use the clipboard service if document.execCommand('paste') was not successful
                return (async () => {`;
  const webReplace = `if (platform.isWeb || typeof navigator !== 'undefined' && !!navigator.clipboard?.readText) {
                // Patched by modern-monaco: also run when a process polyfill
                // made isWeb false (see patch-8).
                logService.trace('registerExecCommandImpl (Paste handling on web)');
                // Use the clipboard service if document.execCommand('paste') was not successful
                return (async () => {`;
  if (js.includes(webSearch)) {
    js = js.replace(webSearch, webReplace);
    console.log("[patch-7b]", path.slice("node_modules/".length));
  } else if (!js.includes("Patched by modern-monaco: also run when a process polyfill")) {
    console.warn("[patch-7b] clipboard.js isWeb paste fallback changed — update patch");
  }
  await Bun.write(path, js);
}

// [patch-8] Hosts that polyfill `process.versions.node` (browser-vite, etc.) make
// Monaco's platform.js classify the runtime as native Node. That sets isWeb
// false, binds Ctrl+V to PasteAction, and skips the web clipboard fallback —
// so paste silently no-ops. Prefer the browser branch whenever `navigator` +
// `document` exist and we're not in Electron.
{
  const path = "node_modules/monaco-editor-core/esm/vs/base/common/platform.js";
  const js = await Bun.file(path).text();
  const search =
    `else if (typeof process !== 'undefined' && typeof process?.versions?.node === 'string') {
    // Native environment (non-sandboxed)
    nodeProcess = process;
}`;
  const replace =
    `else if (typeof process !== 'undefined' && typeof process?.versions?.node === 'string'
    // Patched by modern-monaco: a browser process polyfill still has
    // versions.node, but paste/clipboard must use the web code paths.
    && !(typeof navigator === 'object' && typeof document !== 'undefined')) {
    // Native environment (non-sandboxed)
    nodeProcess = process;
}`;
  if (js.includes(search)) {
    await Bun.write(path, js.replace(search, replace));
    console.log("[patch-8]", path.slice("node_modules/".length));
  } else if (!js.includes("Patched by modern-monaco: a browser process polyfill")) {
    console.warn("[patch-8] platform.js nodeProcess detection changed — update patch");
  }
}
