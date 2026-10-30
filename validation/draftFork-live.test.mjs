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
const livePath = fileURLToPath(new URL("../draftFork/live.ts", import.meta.url));

const result = await build({
    stdin: {
        contents: `export { readContext, applyDraft } from ${JSON.stringify(livePath)}; export * as mock from "@webpack/common";`,
        resolveDir: repo
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [{
        name: "discord-draft-test-double",
        setup(builder) {
            builder.onResolve({ filter: /^@webpack\/common$/ }, () => ({ path: "common", namespace: "mock" }));
            builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
                contents: `
                    export const DraftType = { ChannelMessage: 17, SlashCommand: 23 };
                    let state;
                    const calls = [];
                    export function reset() {
                        state = { accountId: "account-a", channelId: "channel-a", drafts: {}, editing: {}, replies: {}, uploads: {} };
                        calls.length = 0;
                    }
                    export function configure(patch) { Object.assign(state, structuredClone(patch)); }
                    export function seed(accountId, channelId, draftType, draft, timestamp, command) {
                        state.drafts[accountId] ??= {};
                        state.drafts[accountId][channelId] ??= {};
                        state.drafts[accountId][channelId][draftType] = { draft, timestamp, command };
                    }
                    export function snapshot() { return structuredClone(state); }
                    export function recordedCalls() { return structuredClone(calls); }
                    export const UserStore = { getCurrentUser: () => state.accountId ? { id: state.accountId } : undefined };
                    export const SelectedChannelStore = { getChannelId: () => state.channelId };
                    export const DraftStore = {
                        getDraft: (channelId, draftType) => state.drafts[state.accountId]?.[channelId]?.[draftType]?.draft ?? "",
                        getState: () => state.drafts,
                        getDraftCommand: (channelId, draftType) => state.drafts[state.accountId]?.[channelId]?.[draftType]?.command
                    };
                    export const EditMessageStore = { isEditingAny: channelId => Boolean(state.editing[channelId]) };
                    export const PendingReplyStore = { getPendingReply: channelId => state.replies[channelId] };
                    export const UploadAttachmentStore = {
                        getUploadCount: (channelId, draftType) => state.uploads[channelId]?.[draftType] ?? 0
                    };
                    export const DraftActions = {
                        saveDraft(...args) { calls.push({ method: "saveDraft", args }); },
                        changeDraft(...args) { calls.push({ method: "changeDraft", args }); throw new Error("Wrong draft action"); }
                    };
                    export const ComponentDispatch = {
                        dispatchToLastSubscribed(...args) { calls.push({ method: "lastComposer", args }); throw new Error("Wrong composer action"); }
                    };
                    reset();
                `
            }));
        }
    }]
});

const { readContext, applyDraft, mock } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("Live context returns the selected account, channel, text and timestamp", () => {
    mock.reset();
    mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, "Current unsent text", 345);
    assert.deepEqual(readContext("channel-a"), {
        accountId: "account-a", channelId: "channel-a", text: "Current unsent text", stamp: 345, blockedReason: ""
    });
});

test("Draft text and timestamp are read from the current account and exact target channel", () => {
    mock.reset();
    mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, "A in channel A", 100);
    mock.seed("account-a", "channel-b", mock.DraftType.ChannelMessage, "A in channel B", 200);
    mock.seed("account-b", "channel-a", mock.DraftType.ChannelMessage, "B in channel A", 300);
    assert.equal(readContext("channel-a").text, "A in channel A");
    mock.configure({ channelId: "channel-b" });
    assert.deepEqual(readContext("channel-b"), {
        accountId: "account-a", channelId: "channel-b", text: "A in channel B", stamp: 200, blockedReason: ""
    });
    mock.configure({ accountId: "account-b", channelId: "channel-a" });
    assert.deepEqual(readContext("channel-a"), {
        accountId: "account-b", channelId: "channel-a", text: "B in channel A", stamp: 300, blockedReason: ""
    });
});

test("Missing or empty draft text and a zero timestamp remain valid", () => {
    mock.reset();
    assert.deepEqual(readContext("channel-a"), {
        accountId: "account-a", channelId: "channel-a", text: "", stamp: 0, blockedReason: ""
    });
    mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, "", 0);
    assert.deepEqual(readContext("channel-a"), {
        accountId: "account-a", channelId: "channel-a", text: "", stamp: 0, blockedReason: ""
    });
});

test("Reading a Unicode draft preserves all whitespace and normalization", () => {
    mock.reset();
    const text = "  Tiếng Việt đặng\n👨‍👩‍👧‍👦 日本語\te\u0301  ";
    mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, text, 100);
    assert.equal(readContext("channel-a").text, text);
});

for (const [name, setup, reason] of [
    ["editing a sent message", () => mock.configure({ editing: { "channel-a": true } }), /Finish editing the sent message/],
    ["a pending reply", () => mock.configure({ replies: { "channel-a": { messageId: "reply-source" } } }), /Cancel the reply/],
    ["a normal composer upload", () => mock.configure({ uploads: { "channel-a": { [mock.DraftType.ChannelMessage]: 1 } } }), /Remove attachments/],
    ["a command on the normal draft", () => mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, "Text", 100, { id: "normal-command" }), /Exit the slash command/],
    ["a command on the slash draft", () => mock.seed("account-a", "channel-a", mock.DraftType.SlashCommand, "Command", 100, { id: "slash-command" }), /Exit the slash command/],
    ["a missing account", () => mock.configure({ accountId: "" }), /Switch back to the account and channel/],
    ["the wrong selected channel", () => mock.configure({ channelId: "channel-b" }), /Switch back to the account and channel/]
]) {
    test(`Live context blocks ${name}`, () => {
        mock.reset();
        mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, "Text", 100);
        setup();
        assert.match(readContext("channel-a").blockedReason, reason);
        assert.deepEqual(mock.recordedCalls(), []);
    });
}

test("Unsupported state in another channel does not block the target draft", () => {
    mock.reset();
    mock.configure({
        editing: { "channel-b": true }, replies: { "channel-b": { messageId: "other" } },
        uploads: { "channel-b": { [mock.DraftType.ChannelMessage]: 5 } }
    });
    mock.seed("account-a", "channel-b", mock.DraftType.SlashCommand, "Other command", 1, { id: "other-command" });
    assert.equal(readContext("channel-a").blockedReason, "");
});

test("A context read never mutates draft data or calls composer actions", () => {
    mock.reset();
    mock.seed("account-a", "channel-a", mock.DraftType.ChannelMessage, "Private unsent text", 111);
    mock.seed("account-b", "channel-a", mock.DraftType.ChannelMessage, "Other account text", 222);
    const before = mock.snapshot();
    const first = readContext("channel-a");
    first.text = "Caller changed returned context";
    assert.equal(readContext("channel-a").text, "Private unsent text");
    assert.deepEqual(mock.snapshot(), before);
    assert.deepEqual(mock.recordedCalls(), []);
});

test("Applying a draft calls only saveDraft with the exact channel, text and exported draft type", () => {
    mock.reset();
    const before = mock.snapshot();
    for (const text of ["Replacement text", "", "  đặng\n😀\te\u0301  "])
        applyDraft("explicit-target", text);
    assert.deepEqual(mock.recordedCalls(), [
        { method: "saveDraft", args: ["explicit-target", "Replacement text", mock.DraftType.ChannelMessage] },
        { method: "saveDraft", args: ["explicit-target", "", mock.DraftType.ChannelMessage] },
        { method: "saveDraft", args: ["explicit-target", "  đặng\n😀\te\u0301  ", mock.DraftType.ChannelMessage] }
    ]);
    assert.deepEqual(mock.snapshot(), before);
});
