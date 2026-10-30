/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(process.env.EQUICORD_DIR ?? process.cwd());
const require = createRequire(resolve(repo, "package.json"));
const { build } = require("esbuild");
const pluginDir = fileURLToPath(new URL("../draftFork/", import.meta.url));

const result = await build({
    stdin: {
        contents: `export { readHistory, changeHistory, saveRecovery } from ${JSON.stringify(resolve(pluginDir, "data.ts"))}; export { appendRevision, MAX_REVISIONS } from ${JSON.stringify(resolve(pluginDir, "model.ts"))}; export * as mock from "@api/DataStore";`,
        resolveDir: repo
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [{
        name: "datastore-test-double",
        setup(builder) {
            builder.onResolve({ filter: /^@api\/DataStore$/ }, () => ({ path: "datastore", namespace: "mock" }));
            builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
                contents: `
                    const values = new Map();
                    const queues = new Map();
                    const writes = new Map();
                    let failNext = false;
                    export async function get(key) { return structuredClone(values.get(key)); }
                    export function update(key, updater) {
                        const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
                            await Promise.resolve();
                            const value = updater(structuredClone(values.get(key)));
                            if (failNext) { failNext = false; throw new Error("Storage commit failed"); }
                            values.set(key, structuredClone(value));
                            writes.set(key, (writes.get(key) ?? 0) + 1);
                        });
                        queues.set(key, run.catch(() => undefined));
                        return run;
                    }
                    export function reset() { values.clear(); queues.clear(); writes.clear(); failNext = false; }
                    export function seed(key, value) { values.set(key, structuredClone(value)); }
                    export function peek(key) { return structuredClone(values.get(key)); }
                    export function writeCount(key) { return writes.get(key) ?? 0; }
                    export function failNextUpdate() { failNext = true; }
                `
            }));
        }
    }]
});

const { readHistory, changeHistory, saveRecovery, appendRevision, MAX_REVISIONS, mock } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const storageKey = (account, channel) => `DraftFork_v1_${account}_${channel}`;
const revision = (id, text = `Draft ${id}`) => ({ id, label: `Mốc ${id}`, text, kind: "checkpoint", createdAt: 1000 });

test("Missing channel history starts empty without creating persisted data", async () => {
    mock.reset();
    assert.deepEqual(await readHistory("account-a", "channel-a"), []);
    assert.deepEqual(await readHistory("account-b", "channel-a"), []);
    assert.deepEqual(await readHistory("account-a", "channel-b"), []);
    assert.equal(mock.peek(storageKey("account-a", "channel-a")), undefined);
    assert.equal(mock.writeCount(storageKey("account-a", "channel-a")), 0);
});

test("History stays isolated by both Discord account and channel", async () => {
    mock.reset();
    for (const [account, channel, id] of [
        ["account-a", "channel-a", "a-a"], ["account-a", "channel-b", "a-b"],
        ["account-b", "channel-a", "b-a"], ["account-b", "channel-b", "b-b"]
    ]) await changeHistory(account, channel, () => [revision(id)]);

    assert.deepEqual(await readHistory("account-a", "channel-a"), [revision("a-a")]);
    assert.deepEqual(await readHistory("account-a", "channel-b"), [revision("a-b")]);
    assert.deepEqual(await readHistory("account-b", "channel-a"), [revision("b-a")]);
    assert.deepEqual(await readHistory("account-b", "channel-b"), [revision("b-b")]);
});

test("Returned values cannot mutate persisted drafts or a different channel", async () => {
    mock.reset();
    const original = revision("original");
    const returned = await changeHistory("account-a", "channel-a", () => [original]);
    returned[0].text = "Changed outside storage";
    original.label = "Changed input";
    const loaded = await readHistory("account-a", "channel-a");
    loaded[0].text = "Changed read result";
    assert.deepEqual(await readHistory("account-a", "channel-a"), [revision("original")]);
    assert.deepEqual(await readHistory("account-a", "channel-b"), []);
});

test("Twenty five concurrent appends retain every revision in transactional order", async () => {
    mock.reset();
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) =>
        changeHistory("account-a", "channel-a", history => appendRevision(history, revision(`r-${index}`)))
    ));
    const saved = await readHistory("account-a", "channel-a");
    assert.deepEqual(saved.map(item => item.id), Array.from({ length: 25 }, (_, index) => `r-${index}`));
    assert.deepEqual(results.map(items => items.length), Array.from({ length: 25 }, (_, index) => index + 1));
    assert.deepEqual(await readHistory("account-b", "channel-a"), []);
    assert.deepEqual(await readHistory("account-a", "channel-b"), []);
});

test("Corrupt stored envelopes reject without calling a transform or overwriting data", async () => {
    for (const corrupted of [
        { plugin: "DraftFork", version: 99, revisions: [revision("valuable")] },
        { plugin: "DraftFork", version: 1, revisions: [{ id: "valuable", text: "Unsent private text" }] }
    ]) {
        mock.reset();
        const key = storageKey("account-a", "channel-a");
        mock.seed(key, corrupted);
        await assert.rejects(readHistory("account-a", "channel-a"));
        let transformed = false;
        await assert.rejects(changeHistory("account-a", "channel-a", () => {
            transformed = true;
            return [revision("new")];
        }));
        assert.equal(transformed, false);
        assert.deepEqual(mock.peek(key), corrupted);
        assert.equal(mock.writeCount(key), 0);
    }
});

test("Invalid transformed data cannot commit and a later valid update still works", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    await changeHistory("account-a", "channel-a", () => [revision("original")]);
    await assert.rejects(changeHistory("account-a", "channel-a", history => [...history, { ...revision("bad"), kind: "invalid" }]));
    assert.deepEqual(await readHistory("account-a", "channel-a"), [revision("original")]);
    assert.equal(mock.writeCount(key), 1);
    await changeHistory("account-a", "channel-a", history => appendRevision(history, revision("valid")));
    assert.deepEqual((await readHistory("account-a", "channel-a")).map(item => item.id), ["original", "valid"]);
});

test("Appending the fiftieth revision succeeds and the fifty first cannot evict anything", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    await changeHistory("account-a", "channel-a", () => Array.from({ length: MAX_REVISIONS - 1 }, (_, index) => revision(`r-${index}`)));
    await changeHistory("account-a", "channel-a", history => appendRevision(history, revision("fiftieth")));
    const before = mock.peek(key);
    await assert.rejects(changeHistory("account-a", "channel-a", history => appendRevision(history, revision("rejected"))), /up to 50/);
    assert.deepEqual(mock.peek(key), before);
    assert.equal(mock.writeCount(key), 2);
});

test("A full history rejects a recovery backup without evicting any checkpoint", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    const full = Array.from({ length: MAX_REVISIONS }, (_, index) => revision(`r-${index}`));
    await changeHistory("account-a", "channel-a", () => full);
    const before = mock.peek(key);
    await assert.rejects(saveRecovery("account-a", "channel-a", "Current unsent draft", full[0]), /up to 50/);
    assert.deepEqual(mock.peek(key), before);
    assert.equal(mock.writeCount(key), 1);
});

test("Recovery validates the selected version then saves the exact current text including empty text", async () => {
    for (const current of ["", "  đặng\n😀\te\u0301  "]) {
        mock.reset();
        const target = revision("selected", "Selected snapshot");
        await changeHistory("account-a", "channel-a", () => [target]);
        const before = Date.now();
        const saved = await saveRecovery("account-a", "channel-a", current, target);
        assert.deepEqual(saved[0], target);
        assert.equal(saved.length, 2);
        assert.equal(saved[1].kind, "recovery");
        assert.equal(saved[1].label, "Before restore");
        assert.equal(saved[1].text, current);
        assert.notEqual(saved[1].id, target.id);
        assert.ok(saved[1].createdAt >= before && saved[1].createdAt <= Date.now());
        assert.deepEqual(await readHistory("account-a", "channel-a"), saved);
        assert.deepEqual(await readHistory("account-b", "channel-a"), []);
        assert.deepEqual(await readHistory("account-a", "channel-b"), []);
    }
});

test("A deleted selected version rejects recovery without committing a backup", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    await changeHistory("account-a", "channel-a", () => [revision("remaining")]);
    const before = mock.peek(key);
    await assert.rejects(saveRecovery("account-a", "channel-a", "Current", revision("deleted")), /has changed or been deleted/);
    assert.deepEqual(mock.peek(key), before);
    assert.equal(mock.writeCount(key), 1);
});

test("A selected version with changed text rejects recovery even with the same ID", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    const selectedBeforeChange = revision("selected", "e\u0301");
    await changeHistory("account-a", "channel-a", () => [revision("selected", "é")]);
    const before = mock.peek(key);
    await assert.rejects(saveRecovery("account-a", "channel-a", "Current", selectedBeforeChange), /has changed or been deleted/);
    assert.deepEqual(mock.peek(key), before);
    assert.equal(mock.writeCount(key), 1);
});

test("A failed storage commit preserves existing revisions and the transaction queue recovers", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    await changeHistory("account-a", "channel-a", () => [revision("original")]);
    const before = mock.peek(key);
    mock.failNextUpdate();
    await assert.rejects(changeHistory("account-a", "channel-a", history => appendRevision(history, revision("not-saved"))), /Storage commit failed/);
    assert.deepEqual(mock.peek(key), before);
    assert.equal(mock.writeCount(key), 1);
    await changeHistory("account-a", "channel-a", history => appendRevision(history, revision("saved-later")));
    assert.deepEqual((await readHistory("account-a", "channel-a")).map(item => item.id), ["original", "saved-later"]);
});

test("A failed recovery commit never reports success or leaves a phantom recovery entry", async () => {
    mock.reset();
    const key = storageKey("account-a", "channel-a");
    const target = revision("selected");
    await changeHistory("account-a", "channel-a", () => [target]);
    const before = mock.peek(key);
    mock.failNextUpdate();
    await assert.rejects(saveRecovery("account-a", "channel-a", "Current draft", target), /Storage commit failed/);
    assert.deepEqual(mock.peek(key), before);
    assert.equal(mock.writeCount(key), 1);
    assert.deepEqual(await readHistory("account-a", "channel-a"), [target]);
});
