/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Revision {
    id: string;
    label: string;
    text: string;
    createdAt: number;
    kind: "checkpoint" | "variant" | "recovery";
    parentId?: string;
}

export const MAX_REVISIONS = 50;
export const MAX_TEXT = 20000;
export const MAX_LABEL = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 100;
}

export function parseHistory(value: unknown): Revision[] {
    if (value === undefined) return [];
    if (!isRecord(value) || value.plugin !== "DraftFork" || value.version !== 1 || !Array.isArray(value.revisions))
        throw new Error("This is not valid DraftFork version 1 data.");
    if (value.revisions.length > MAX_REVISIONS)
        throw new Error(`Each channel can hold up to ${MAX_REVISIONS} checkpoints. Delete one before saving another.`);

    const ids = new Set<string>();
    return Array.from(value.revisions, (revision: unknown): Revision => {
        if (!isRecord(revision)
            || !isId(revision.id)
            || typeof revision.label !== "string" || !revision.label.trim() || revision.label.length > MAX_LABEL
            || typeof revision.text !== "string" || revision.text.length > MAX_TEXT
            || typeof revision.createdAt !== "number" || !Number.isSafeInteger(revision.createdAt)
            || revision.createdAt < 0 || revision.createdAt > 8_640_000_000_000_000
            || (revision.kind !== "checkpoint" && revision.kind !== "variant" && revision.kind !== "recovery")
            || (revision.parentId !== undefined && !isId(revision.parentId)))
            throw new Error("The history contains an invalid draft version.");
        if (ids.has(revision.id))
            throw new Error("The history contains duplicate version IDs.");
        ids.add(revision.id);

        return {
            id: revision.id,
            label: revision.label,
            text: revision.text,
            createdAt: revision.createdAt,
            kind: revision.kind,
            ...(revision.parentId === undefined ? {} : { parentId: revision.parentId })
        };
    });
}

export function packHistory(revisions: Revision[]): { plugin: "DraftFork"; version: 1; revisions: Revision[]; } {
    return {
        plugin: "DraftFork",
        version: 1,
        revisions: parseHistory({ plugin: "DraftFork", version: 1, revisions })
    };
}

export function appendRevision(existing: Revision[], revision: Revision): Revision[] {
    return packHistory([...existing, revision]).revisions;
}

export function removeRevision(existing: Revision[], id: string): Revision[] {
    return packHistory(existing.filter(revision => revision.id !== id)).revisions;
}
