/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendRevision, MAX_LABEL, MAX_REVISIONS, MAX_TEXT, packHistory, parseHistory, removeRevision, type Revision } from "../draftFork/model.ts";

function revision(overrides: Partial<Revision> = {}): Revision {
    return { id: "original", label: "Bản đầu", text: "Chào bạn", createdAt: 1_700_000_000_000, kind: "checkpoint", ...overrides };
}

function envelope(revisions: unknown) {
    return { plugin: "DraftFork", version: 1, revisions };
}

test("History roundtrips all revision kinds, Unicode and an empty recovery draft", () => {
    const source = [
        revision({ text: "đề xuất 👨‍👩‍👧‍👦\n日本語\nمرحبا\ne\u0301" }),
        revision({ id: "variant", label: "Cách khác", kind: "variant", parentId: "original" }),
        revision({ id: "empty", label: "Trước khôi phục", text: "", kind: "recovery", parentId: "variant", createdAt: 0 })
    ];
    assert.deepEqual(parseHistory(JSON.parse(JSON.stringify(packHistory(source)))), source);
    assert.deepEqual(parseHistory(undefined), []);
});

test("History rejects malformed envelopes rather than resetting saved data", () => {
    for (const input of [null, [], "{}", {}, { plugin: "Other", version: 1, revisions: [] }, { plugin: "DraftFork", version: 2, revisions: [] }, { plugin: "DraftFork", version: "1", revisions: [] }, { plugin: "DraftFork", version: 1 }, envelope(null), envelope({}), envelope(Array(1))])
        assert.throws(() => parseHistory(input));
});

test("History rejects invalid IDs, fields, kinds and dates", () => {
    const invalidFields: Record<string, unknown>[] = [
        { id: "" }, { id: "a".repeat(101) }, { id: 10 },
        { label: "" }, { label: " \t\n" }, { label: "a".repeat(MAX_LABEL + 1) }, { label: null },
        { text: 42 }, { text: undefined }, { text: "a".repeat(MAX_TEXT + 1) },
        { kind: "draft" }, { kind: null },
        { createdAt: -1 }, { createdAt: 0.5 }, { createdAt: NaN }, { createdAt: Infinity }, { createdAt: "123" }, { createdAt: 8_640_000_000_000_001 },
        { parentId: "" }, { parentId: "a".repeat(101) }, { parentId: 1 }, { parentId: null }
    ];
    for (const fields of invalidFields)
        assert.throws(() => parseHistory(envelope([{ ...revision(), ...fields }])));
});

test("History accepts exact limits and preserves text without normalization", () => {
    const source = revision({ id: "a".repeat(100), parentId: "b".repeat(100), label: "a".repeat(MAX_LABEL), text: "😀".repeat(MAX_TEXT / 2), createdAt: 8_640_000_000_000_000 });
    assert.deepEqual(parseHistory(envelope([source])), [source]);
    const spaces = revision({ label: "  Nháp  ", text: "  \n\t" });
    assert.deepEqual(parseHistory(envelope([spaces])), [spaces]);
});

test("History strips unknown fields and creates separate validated objects", () => {
    const source = { ...revision(), unexpected: "private extra", nested: { value: 1 } };
    const packed = packHistory([source]);
    assert.deepEqual(packed, { plugin: "DraftFork", version: 1, revisions: [revision()] });
    assert.notStrictEqual(packed.revisions[0], source);
    packed.revisions[0].text = "changed";
    assert.equal(source.text, "Chào bạn");
    assert.deepEqual(parseHistory({ ...envelope([source]), extra: true }), [revision()]);
});

test("Duplicate IDs fail for stored data and append without changing the original", () => {
    const original = [revision()];
    const before = structuredClone(original);
    assert.throws(() => parseHistory(envelope([revision(), revision({ text: "Different" })])));
    assert.throws(() => appendRevision(original, revision({ text: "Different" })));
    assert.deepEqual(original, before);
});

test("Appending at capacity rejects without evicting any saved or recovery revision", () => {
    const full = Array.from({ length: MAX_REVISIONS }, (_, index) => revision({ id: String(index), kind: index === 0 ? "recovery" : "checkpoint" }));
    const before = structuredClone(full);
    assert.equal(parseHistory(envelope(full)).length, MAX_REVISIONS);
    assert.throws(() => appendRevision(full, revision({ id: "new" })));
    assert.throws(() => parseHistory(envelope([...full, revision({ id: "new" })])));
    assert.deepEqual(full, before);
});

test("Append preserves order and content without mutating either input", () => {
    const existing = [revision()];
    const incoming = revision({ id: "fork", label: "Phương án B", text: "", kind: "variant", parentId: "original" });
    const result = appendRevision(existing, incoming);
    assert.deepEqual(result, [...existing, incoming]);
    assert.equal(existing.length, 1);
    result[0].text = "Changed";
    result[1].label = "Changed";
    assert.equal(existing[0].text, "Chào bạn");
    assert.equal(incoming.label, "Phương án B");
});

test("Deleting a revision preserves descendants and their dangling parent references", () => {
    const child = revision({ id: "child", kind: "variant", parentId: "original" });
    const existing = [revision(), child, revision({ id: "grandchild", kind: "variant", parentId: "child" })];
    const before = structuredClone(existing);
    const remaining = removeRevision(existing, "original");
    assert.deepEqual(remaining, existing.slice(1));
    assert.equal(remaining[0].parentId, "original");
    assert.deepEqual(parseHistory(packHistory(remaining)), remaining);
    assert.deepEqual(removeRevision(remaining, "missing"), remaining);
    assert.deepEqual(existing, before);
});
