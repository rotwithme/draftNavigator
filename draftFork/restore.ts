/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Revision } from "./model";

export const MAX_RESTORE_TEXT = 4500;

export interface DraftContext {
    accountId: string;
    channelId: string;
    text: string;
    stamp: number;
    blockedReason: string;
}

export interface RestorePorts {
    current(): DraftContext;
    active(): boolean;
    saveRecovery(expected: DraftContext, target: Revision): Promise<Revision[]>;
    apply(text: string): void;
}

export function sameContext(left: DraftContext, right: DraftContext): boolean {
    return left.accountId === right.accountId && left.channelId === right.channelId
        && left.text === right.text && left.stamp === right.stamp && left.blockedReason === right.blockedReason;
}

export async function restoreProtected(expected: DraftContext, target: Revision, ports: RestorePorts): Promise<Revision[]> {
    function check() {
        if (!ports.active()) throw new Error("The DraftFork window is closed or the plugin is disabled. The draft has not been changed.");
        const current = ports.current();
        if (!current.accountId || !current.channelId || current.blockedReason)
            throw new Error(current.blockedReason || "This composer is no longer active.");
        if (!sameContext(expected, current))
            throw new Error("The draft or context has changed. Refresh the comparison before restoring.");
    }
    check();
    if (target.text.length > MAX_RESTORE_TEXT)
        throw new Error(`This checkpoint exceeds the ${MAX_RESTORE_TEXT.toLocaleString("en-US")}-character restore limit. Create a shorter variant before restoring.`);
    if (expected.text === target.text) throw new Error("The current draft already matches this checkpoint.");
    const history = await ports.saveRecovery(expected, target);
    check();
    ports.apply(target.text);
    const after = ports.current();
    if (after.accountId !== expected.accountId || after.channelId !== expected.channelId || after.text !== target.text)
        throw new Error("Discord has not confirmed the new text. The recovery copy is saved. Check the composer before continuing.");
    return history;
}
