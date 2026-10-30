/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { appendRevision, packHistory, parseHistory, Revision } from "./model";

function key(accountId: string, channelId: string) {
    return `DraftFork_v1_${accountId}_${channelId}`;
}

export async function readHistory(accountId: string, channelId: string): Promise<Revision[]> {
    return parseHistory(await DataStore.get<unknown>(key(accountId, channelId)));
}

export async function changeHistory(accountId: string, channelId: string, change: (history: Revision[]) => Revision[]): Promise<Revision[]> {
    let result: Revision[] = [];
    await DataStore.update<unknown>(key(accountId, channelId), old => {
        const envelope = packHistory(change(parseHistory(old)));
        result = envelope.revisions;
        return envelope;
    });
    return result;
}

export async function saveRecovery(accountId: string, channelId: string, text: string, target: Revision): Promise<Revision[]> {
    return changeHistory(accountId, channelId, history => {
        if (!history.some(item => item.id === target.id && item.text === target.text))
            throw new Error("This checkpoint has changed or been deleted. Close and reopen DraftFork.");
        return appendRevision(history, {
            id: crypto.randomUUID(),
            label: "Before restore",
            text,
            kind: "recovery",
            createdAt: Date.now()
        });
    });
}
