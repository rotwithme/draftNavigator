/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.env.EQUICORD_DIR || path.resolve(here, "../Equicord");
const source = process.env.DRAFTFORK_DIR || path.resolve(here, "../../draftFork");
const require = createRequire(import.meta.url);
const repoRequire = createRequire(path.join(repo, "package.json"));
const { build } = repoRequire("esbuild");
const result = await build({
    stdin: { contents: `export { default as plugin } from ${JSON.stringify(path.join(source, "index.tsx"))}; export * as common from "@webpack/common"; export * as storage from "@api/DataStore";`, resolveDir: here },
    bundle: true, write: false, platform: "node", format: "esm", jsx: "transform", jsxFactory: "React.createElement",
    plugins: [{ name: "discord-ui-test-doubles", setup(builder) {
        builder.onResolve({ filter: /^react$/ }, () => ({ path: pathToFileURL(require.resolve("react")).href, external: true }));
        builder.onResolve({ filter: /^diff$/ }, () => ({ path: repoRequire.resolve("diff") }));
        builder.onResolve({ filter: /^@webpack\/common$/ }, () => ({ path: path.join(here, "common.mjs") }));
        builder.onResolve({ filter: /^@api\/DataStore$/ }, () => ({ path: path.join(here, "storage.mjs") }));
        builder.onResolve({ filter: /^(@components\/|@utils\/|@api\/ChatButtons)/ }, args => ({ path: args.path, namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, args => {
            const common = '"@webpack/common"';
            if (args.path === "@utils/types") return { contents: "export default value => value;" };
            if (args.path === "@utils/css") return { contents: 'export const classNameFactory = prefix => suffix => prefix + suffix;' };
            if (args.path === "@components/ErrorBoundary") return { contents: `export { default } from ${common};` };
            if (args.path === "@api/ChatButtons") return { contents: `export { Button as ChatBarButton } from ${common};` };
            const name = args.path === "@utils/web" ? "saveFile" : args.path === "@components/Icons" ? "CopyIcon" : args.path.split("/").at(-1);
            return { contents: `export { ${name} } from ${common};` };
        });
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    } }]
});
const { plugin, common, storage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://local.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent", "Event", "File"])
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
let root;
const original = { id: "first", label: "Original A", text: "Saved A", createdAt: 1, kind: "checkpoint" };
function Host() {
    React.useSyncExternalStore(common.subscribe, common.revision);
    return common.modal?.render({ onClose: common.closeModal });
}
function button(name) { return [...container.querySelectorAll("button")].find(node => node.textContent === name || node.getAttribute("aria-label") === name); }
async function click(name) {
    const node = button(name);
    assert.ok(node, `Missing button: ${name}`);
    assert.equal(node.disabled, false, `Disabled button: ${name}`);
    await act(async () => { node.click(); });
}
async function input(label, value) {
    const node = container.querySelector(`[aria-label="${label}"]`);
    assert.ok(node, `Missing input: ${label}`);
    await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value").set.call(node, value);
        node.dispatchEvent(new Event("input", { bubbles: true }));
    });
}
async function open() {
    await act(async () => { plugin.start(); plugin.chatBarButton.render({ channel: { id: "channel-a" }, isMainChat: true, type: { drafts: { type: common.DraftType.ChannelMessage } } }).props.children.props.onClick(); });
}
beforeEach(async () => {
    common.reset(); storage.reset(); storage.seed("account-a", "channel-a", [original]);
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Host))); });
});
afterEach(async () => { await act(async () => { plugin.stop(); root.unmount(); }); });

test("Save checkpoint uses the visible unsent draft without changing the composer", async () => {
    await open(); await input("Checkpoint name", "Current named B"); await click("Save checkpoint");
    assert.equal(storage.history().at(-1).text, "Current B");
    assert.equal(storage.history().at(-1).label, "Current named B");
    assert.deepEqual(common.applied, []);
});
test("Create a child variant in React inputs while keeping the main draft untouched", async () => {
    await open(); await click("Create variant");
    await input("Variant name", "Another tone"); await input("Variant text", "  Tiếng Việt 👨‍👩‍👧‍👦\nsecond line  ");
    await click("Save variant");
    assert.deepEqual(storage.history().at(-1), { id: storage.history().at(-1).id, label: "Another tone", text: "  Tiếng Việt 👨‍👩‍👧‍👦\nsecond line  ", kind: "variant", parentId: "first", createdAt: storage.history().at(-1).createdAt });
    assert.equal(common.context.text, "Current B"); assert.deepEqual(common.applied, []);
});
for (const mode of ["Escape", "backdrop", "header", "footer"]) {
    test(`Dirty variant survives ${mode} until explicitly discarded`, async () => {
        await open(); await click("Create variant"); await input("Variant text", "Unsaved C");
        if (mode === "Escape") await act(async () => { container.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
        if (mode === "backdrop") await act(async () => { common.requestClose(); });
        if (mode === "header") await click("Close dialog");
        if (mode === "footer") await click("Close");
        assert.match(container.textContent, /Your variant has not been saved/);
        assert.equal(container.querySelector('[aria-label="Variant text"]').value, "Unsaved C");
        await click("Keep editing"); assert.ok(common.modal);
        await click("Save variant"); assert.equal(storage.history().at(-1).text, "Unsaved C");
        await act(async () => { common.requestClose(); }); assert.equal(common.modal, undefined);
    });
}
test("Explicit discard closes the modal without saving the variant", async () => {
    await open(); await click("Create variant"); await click("Close"); await click("Discard and close");
    assert.equal(common.modal, undefined); assert.equal(storage.history().length, 1);
});
test("Restore saves the previous draft and writes only the selected channel", async () => {
    await open(); await click("Save current draft and restore");
    assert.equal(storage.history().at(-1).text, "Current B"); assert.equal(storage.history().at(-1).kind, "recovery");
    assert.deepEqual(common.applied, [{ channelId: "channel-a", text: "Saved A", type: 17 }]);
});
test("A changed draft disables restore until the comparison is refreshed", async () => {
    await open(); await act(async () => { common.update({ text: "Changed while open", stamp: 124 }); });
    assert.equal(button("Save current draft and restore").disabled, true);
    await click("Refresh comparison"); await click("Save current draft and restore");
    assert.equal(storage.history().at(-1).text, "Changed while open");
});
for (const change of ["close", "disable", "channel", "account", "text"]) {
    test(`Pending restore does not overwrite composer after ${change}`, async () => {
        await open(); const release = storage.holdNextUpdate();
        await click("Save current draft and restore");
        await act(async () => {
            if (change === "close") common.requestClose();
            if (change === "disable") plugin.stop();
            if (change === "channel") common.update({ channelId: "channel-b", text: "Other channel" });
            if (change === "account") common.update({ accountId: "account-b", text: "Other account" });
            if (change === "text") common.update({ text: "New input", stamp: 125 });
            release();
        });
        assert.deepEqual(common.applied, []);
        assert.equal(storage.history().at(-1).text, "Current B");
    });
}
test("Storage failure leaves the current draft unchanged and reports the error", async () => {
    await open(); storage.failNextUpdate(); await click("Save current draft and restore");
    assert.match(container.textContent, /Storage unavailable/); assert.equal(common.context.text, "Current B");
    assert.deepEqual(common.applied, []); assert.equal(storage.history().length, 1);
});
test("Corrupt stored history stays read-only and does not replace existing data", async () => {
    storage.corrupt(); await open();
    assert.match(container.textContent, /Could not read the checkpoint history/); assert.equal(button("Save checkpoint").disabled, true);
    assert.deepEqual(common.applied, []);
});
test("Full history disables all additions and restore until a revision is deleted", async () => {
    storage.seed("account-a", "channel-a", Array.from({ length: 50 }, (_, index) => ({ ...original, id: `r${index}`, label: `Revision ${index}` })));
    await open();
    for (const name of ["Save checkpoint", "Create variant", "Save current draft and restore"]) assert.equal(button(name).disabled, true);
    await click("Delete checkpoint"); await click("Delete this checkpoint"); assert.equal(storage.history().length, 49);
    assert.equal(button("Save checkpoint").disabled, false);
    assert.equal(button("Save current draft and restore").disabled, false);
});
test("Export uses persisted history and includes account and channel metadata", async () => {
    await open(); await click("Export backup");
    assert.equal(common.files.length, 1); assert.equal(common.files[0].name, "DraftFork-channel-a.json");
    const content = await new Promise((resolve, reject) => {
        const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(common.files[0]);
    });
    assert.deepEqual(JSON.parse(content), { plugin: "DraftFork", version: 1, revisions: [original], accountId: "account-a", channelId: "channel-a" });
});
test("Unsupported composer states disable checkpoint and restore", async () => {
    await open();
    for (const patch of [{ editing: true }, { reply: true }, { uploads: 1 }, { command: true }]) {
        await act(async () => { common.update({ editing: false, reply: false, uploads: 0, command: false, ...patch }); });
        assert.equal(button("Save checkpoint").disabled, true);
        assert.equal(button("Save current draft and restore").disabled, true);
    }
});

test("Oversized stored revisions remain readable and exportable but cannot replace the draft", async () => {
    storage.seed("account-a", "channel-a", [{ ...original, text: "x".repeat(4501) }]);
    await open();
    assert.equal(button("Save current draft and restore").disabled, true);
    assert.match(container.textContent, /exceeds/);
    await click("Create variant");
    assert.equal(button("Save variant").disabled, true);
    assert.equal(container.querySelector('[aria-label="Variant text"]').maxLength, 4500);
    await input("Variant text", "Shortened version"); await click("Save variant");
    assert.equal(storage.history()[0].text.length, 4501);
    await click("Save current draft and restore");
    assert.equal(common.context.text, "Shortened version");
});
