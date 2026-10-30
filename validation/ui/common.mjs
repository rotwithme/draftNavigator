/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import React from "react";
export { React };
export const { useState, useEffect, useLayoutEffect, useMemo } = React;

const listeners = new Set();
let version = 0;
export let modal;
export let context;
export const applied = [];
export const files = [];
export const DraftType = { ChannelMessage: 17, SlashCommand: 23 };
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function revision() { return version; }
function emit() { version++; for (const listener of [...listeners]) listener(); }
export function reset() {
    context = { accountId: "account-a", channelId: "channel-a", text: "Current B", stamp: 123, editing: false, reply: false, uploads: 0, command: false };
    modal = undefined;
    applied.length = 0;
    files.length = 0;
    emit();
}
export function update(patch) { Object.assign(context, patch); emit(); }
export function openModal(render, options) { modal = { render, options }; emit(); }
export function closeModal() {
    const closed = modal;
    modal = undefined;
    closed?.options.onCloseCallback?.();
    emit();
}
export function requestClose() { (modal?.options.onCloseRequest ?? closeModal)(); }
export const UserStore = { getCurrentUser: () => context.accountId ? { id: context.accountId } : undefined };
export const SelectedChannelStore = { getChannelId: () => context.channelId };
export const ChannelStore = { getChannel: () => ({ name: "test-channel" }) };
export const DraftStore = {
    getDraft: () => context.text,
    getState: () => ({ [context.accountId]: { [context.channelId]: { [DraftType.ChannelMessage]: { timestamp: context.stamp } } } }),
    getDraftCommand: () => context.command || undefined
};
export const UploadAttachmentStore = { getUploadCount: () => context.uploads };
export const PendingReplyStore = { getPendingReply: () => context.reply || undefined };
export const EditMessageStore = { isEditingAny: () => context.editing };
export const DraftActions = {
    saveDraft(channelId, text, type) {
        applied.push({ channelId, text, type });
        update({ text, stamp: context.stamp + 1 });
    }
};
export function useStateFromStores(stores, getter, dependencies, equal) {
    const cached = React.useRef();
    return React.useSyncExternalStore(subscribe, () => {
        const next = getter();
        if (!cached.current || !equal(cached.current, next)) cached.current = next;
        return cached.current;
    });
}
export function Button({ variant, size, children, ...props }) { return React.createElement("button", props, children); }
export function TextInput({ onChange, ...props }) { return React.createElement("input", { ...props, onChange: event => onChange(event.target.value) }); }
export function TextArea({ onChange, ...props }) { return React.createElement("textarea", { ...props, onChange: event => onChange(event.target.value) }); }
export function Heading({ tag = "h3", ...props }) { return React.createElement(tag, props); }
export function Paragraph(props) { return React.createElement("p", props); }
export function CopyIcon() { return React.createElement("svg"); }
export function Modal({ title, subtitle, children, actions, onClose }) {
    return React.createElement("div", { role: "dialog", onKeyDown: event => { if (event.key === "Escape") requestClose(); } },
        React.createElement("h2", null, title),
        React.createElement("p", null, subtitle),
        React.createElement("button", { "aria-label": "Close dialog", onClick: onClose }, "×"),
        children,
        ...actions.map(action => React.createElement(Button, { key: action.text, disabled: action.disabled, onClick: action.onClick }, action.text)));
}
export function saveFile(file) { files.push(file); }
export default Object.assign(function Boundary({ children }) { return children; }, { wrap: Component => Component });
reset();
