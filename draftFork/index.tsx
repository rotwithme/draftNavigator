/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import ErrorBoundary from "@components/ErrorBoundary";
import { CopyIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";
import { closeModal, DraftType, React } from "@webpack/common";

import { openDraftFork, setEnabled } from "./ui";

export default definePlugin({
    name: "DraftFork",
    description: "Keep channel draft versions, compare changes and restore after saving the current text.",
    authors: [{ name: "ItsLucasNG", id: 1170180628315119736n }],
    tags: ["Chat", "Utility", "Organisation"],
    dependencies: ["ChatInputButtonAPI"],
    chatBarButton: {
        icon: CopyIcon,
        render({ channel, isMainChat, type }) {
            if (!isMainChat || type.drafts.type !== DraftType.ChannelMessage) return null;
            return (
                <ErrorBoundary noop>
                    <ChatBarButton tooltip="DraftFork: draft versions" onClick={() => openDraftFork(channel.id)}>
                        <CopyIcon />
                    </ChatBarButton>
                </ErrorBoundary>
            );
        }
    },
    settingsAboutComponent: () => <Paragraph>Use the button beside the main chat input to save draft checkpoints, create variants, compare and restore text. Checkpoints use the shared Equicord DataStore and may be included in Cloud Sync V2 and backups.</Paragraph>,
    start() {
        setEnabled(true);
    },
    stop() {
        setEnabled(false);
        closeModal("DraftFork");
    }
});
