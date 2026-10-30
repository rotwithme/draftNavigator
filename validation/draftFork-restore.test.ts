/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Revision } from "../draftFork/model.ts";
import { type DraftContext, MAX_RESTORE_TEXT, restoreProtected, type RestorePorts } from "../draftFork/restore.ts";

function scenario(targetText = "Bản sẽ khôi phục") {
    const expected: DraftContext = { accountId: "account-A", channelId: "channel-A", text: "Đang viết chưa xong", stamp: 10, blockedReason: "" };
    const target: Revision = { id: "target", label: "Phương án A", text: targetText, createdAt: 1, kind: "checkpoint" };
    const state = { context: { ...expected }, leaseOpen: true, enabled: true, history: [target] };
    const events: string[] = [];
    const ports: RestorePorts = {
        current: () => ({ ...state.context }),
        active: () => state.leaseOpen && state.enabled,
        async saveRecovery(context, revision) {
            events.push("save");
            assert.equal(revision.id, target.id);
            state.history = [...state.history, { id: "recovery", label: "Before restore", text: context.text, createdAt: 2, kind: "recovery" }];
            return state.history;
        },
        apply(text) {
            events.push("apply");
            state.context = { ...state.context, text, stamp: state.context.stamp + 1 };
        }
    };
    return { expected, target, state, events, ports };
}

function pauseRecovery(setup: ReturnType<typeof scenario>) {
    const gate = Promise.withResolvers<void>();
    const originalSave = setup.ports.saveRecovery;
    setup.ports.saveRecovery = async (expected, target) => {
        const history = await originalSave(expected, target);
        await gate.promise;
        setup.events.push("saved");
        return history;
    };
    return gate;
}

test("Restore waits for durable recovery before applying the selected text", async () => {
    const setup = scenario();
    const gate = pauseRecovery(setup);
    const restored = restoreProtected(setup.expected, setup.target, setup.ports);
    assert.deepEqual(setup.events, ["save"]);
    assert.equal(setup.state.context.text, setup.expected.text);
    assert.equal(setup.state.history[1].text, setup.expected.text);
    gate.resolve();
    assert.deepEqual(await restored, setup.state.history);
    assert.deepEqual(setup.events, ["save", "saved", "apply"]);
    assert.equal(setup.state.context.text, setup.target.text);
});

test("An oversized saved revision is rejected before saving recovery or changing the draft", async () => {
    const setup = scenario("😀".repeat(MAX_RESTORE_TEXT / 2) + "x");
    await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /Create a shorter variant/);
    assert.deepEqual(setup.events, []);
    assert.equal(setup.state.context.text, setup.expected.text);
    assert.equal(setup.state.history.length, 1);
});

test("A revision at the Discord draft limit is restored intact", async () => {
    const setup = scenario("😀".repeat(MAX_RESTORE_TEXT / 2));
    await restoreProtected(setup.expected, setup.target, setup.ports);
    assert.equal(setup.state.context.text, setup.target.text);
    assert.equal(setup.state.context.text.length, MAX_RESTORE_TEXT);
});

for (const [field, value] of [
    ["accountId", "account-B"],
    ["channelId", "channel-B"],
    ["text", "Đã gõ thêm"],
    ["stamp", 11]
] as const) {
    test(`An already stale ${field} baseline causes no persistence or draft change`, async () => {
        const setup = scenario();
        setup.state.context = { ...setup.state.context, [field]: value };
        await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /context has changed/);
        assert.deepEqual(setup.events, []);
        assert.equal(setup.state.history.length, 1);
    });

    test(`A ${field} change while recovery is being saved cancels the restore`, async () => {
        const setup = scenario();
        const gate = pauseRecovery(setup);
        const restored = restoreProtected(setup.expected, setup.target, setup.ports);
        setup.state.context = { ...setup.state.context, [field]: value };
        const changed = { ...setup.state.context };
        gate.resolve();
        await assert.rejects(restored, /context has changed/);
        assert.deepEqual(setup.events, ["save", "saved"]);
        assert.deepEqual(setup.state.context, changed);
        assert.equal(setup.state.history[1].kind, "recovery");
        assert.equal(setup.state.history[1].text, setup.expected.text);
    });
}

test("A blocked, signed out or missing channel context causes no save or apply", async () => {
    for (const change of [{ blockedReason: "Có tệp đính kèm" }, { accountId: "" }, { channelId: "" }]) {
        const setup = scenario();
        setup.state.context = { ...setup.state.context, ...change };
        await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports));
        assert.deepEqual(setup.events, []);
        assert.equal(setup.state.history.length, 1);
    }
});

test("A new blocked condition during persistence cancels without changing the draft", async () => {
    const setup = scenario();
    const gate = pauseRecovery(setup);
    const restored = restoreProtected(setup.expected, setup.target, setup.ports);
    setup.state.context.blockedReason = "Có tệp đính kèm mới";
    gate.resolve();
    await assert.rejects(restored, /Có tệp đính kèm mới/);
    assert.deepEqual(setup.events, ["save", "saved"]);
    assert.equal(setup.state.context.text, setup.expected.text);
});

test("A persistence failure leaves the live draft untouched", async () => {
    const setup = scenario();
    setup.ports.saveRecovery = async () => {
        setup.events.push("failed-save");
        throw new Error("Storage unavailable");
    };
    await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /Storage unavailable/);
    assert.deepEqual(setup.events, ["failed-save"]);
    assert.deepEqual(setup.state.context, setup.expected);
    assert.equal(setup.state.history.length, 1);
});

for (const property of ["leaseOpen", "enabled"] as const) {
    test(`An inactive ${property} rejects before any work`, async () => {
        const setup = scenario();
        setup.state[property] = false;
        await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /window is closed or the plugin is disabled/);
        assert.deepEqual(setup.events, []);
    });

    test(`Closing ${property} during persistence keeps recovery and cancels apply`, async () => {
        const setup = scenario();
        const gate = pauseRecovery(setup);
        const restored = restoreProtected(setup.expected, setup.target, setup.ports);
        setup.state[property] = false;
        gate.resolve();
        await assert.rejects(restored, /window is closed or the plugin is disabled/);
        assert.deepEqual(setup.events, ["save", "saved"]);
        assert.equal(setup.state.history.length, 2);
        assert.deepEqual(setup.state.context, setup.expected);
    });
}

test("Restoring identical text is a no-op with no recovery write", async () => {
    const setup = scenario();
    setup.target.text = setup.expected.text;
    await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /already matches/);
    assert.deepEqual(setup.events, []);
    assert.equal(setup.state.history.length, 1);
});

test("An empty target clears the draft only after preserving its nonempty text", async () => {
    const setup = scenario("");
    await restoreProtected(setup.expected, setup.target, setup.ports);
    assert.deepEqual(setup.events, ["save", "apply"]);
    assert.equal(setup.state.context.text, "");
    assert.equal(setup.state.history[1].text, setup.expected.text);
});

test("An initially empty draft is still backed up before restoring nonempty text", async () => {
    const setup = scenario();
    setup.expected.text = "";
    setup.state.context.text = "";
    await restoreProtected(setup.expected, setup.target, setup.ports);
    assert.deepEqual(setup.events, ["save", "apply"]);
    assert.equal(setup.state.history[1].text, "");
    assert.equal(setup.state.context.text, setup.target.text);
});

test("An apply failure retains recovery without retry or rollback", async () => {
    const setup = scenario();
    setup.ports.apply = () => {
        setup.events.push("apply-failed");
        setup.state.context.text = "Partial change made by client";
        throw new Error("Client rejected replacement");
    };
    await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /Client rejected replacement/);
    assert.deepEqual(setup.events, ["save", "apply-failed"]);
    assert.equal(setup.state.history[1].text, setup.expected.text);
    assert.equal(setup.state.context.text, "Partial change made by client");
});

test("Readback mismatch reports failure without applying or rolling back a second time", async () => {
    const setup = scenario();
    setup.ports.apply = () => { setup.events.push("apply"); };
    await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /Discord has not confirmed/);
    assert.deepEqual(setup.events, ["save", "apply"]);
    assert.equal(setup.state.history[1].text, setup.expected.text);
    assert.deepEqual(setup.state.context, setup.expected);
});

test("Changing account during apply is detected even if readback text matches", async () => {
    const setup = scenario();
    setup.ports.apply = text => {
        setup.events.push("apply");
        setup.state.context = { ...setup.state.context, accountId: "account-B", text };
    };
    await assert.rejects(restoreProtected(setup.expected, setup.target, setup.ports), /Discord has not confirmed/);
    assert.deepEqual(setup.events, ["save", "apply"]);
    assert.equal(setup.state.history[1].text, setup.expected.text);
});
