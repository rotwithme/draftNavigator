/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DraftActions, DraftStore, DraftType, EditMessageStore, PendingReplyStore, SelectedChannelStore, UploadAttachmentStore, UserStore } from "@webpack/common";

import type { DraftContext } from "./restore";

export function readContext(targetChannel: string): DraftContext {
    const accountId = UserStore.getCurrentUser()?.id ?? "";
    const channelId = SelectedChannelStore.getChannelId() ?? "";
    const text = DraftStore.getDraft(targetChannel, DraftType.ChannelMessage);
    let blockedReason = "";
    if (!accountId || channelId !== targetChannel) blockedReason = "Switch back to the account and channel you were drafting in.";
    else if (EditMessageStore.isEditingAny(targetChannel)) blockedReason = "Finish editing the sent message before using DraftFork.";
    else if (PendingReplyStore.getPendingReply(targetChannel)) blockedReason = "Cancel the reply before using DraftFork.";
    else if (UploadAttachmentStore.getUploadCount(targetChannel, DraftType.ChannelMessage) > 0) blockedReason = "DraftFork only saves text. Remove attachments before continuing.";
    else if (DraftStore.getDraftCommand(targetChannel, DraftType.ChannelMessage) || DraftStore.getDraftCommand(targetChannel, DraftType.SlashCommand))
        blockedReason = "Exit the slash command before using DraftFork.";
    return {
        accountId,
        channelId,
        text,
        stamp: DraftStore.getState()[accountId]?.[targetChannel]?.[DraftType.ChannelMessage]?.timestamp ?? 0,
        blockedReason
    };
}

export function applyDraft(channelId: string, text: string) {
    const actions: { saveDraft(channelId: string, text: string, draftType: number): void; } = DraftActions;
    actions.saveDraft(channelId, text, DraftType.ChannelMessage);
}
