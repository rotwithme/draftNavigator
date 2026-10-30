/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import { saveFile } from "@utils/web";
import type { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, closeModal, DraftStore, EditMessageStore, Modal, openModal, PendingReplyStore, React, SelectedChannelStore, TextArea, TextInput, UploadAttachmentStore, useEffect, useLayoutEffect, useMemo, UserStore, useState, useStateFromStores } from "@webpack/common";
import { diffLines } from "diff";

import { changeHistory, readHistory, saveRecovery } from "./data";
import { applyDraft, readContext } from "./live";
import { appendRevision, MAX_LABEL, MAX_REVISIONS, MAX_TEXT, packHistory, removeRevision, Revision } from "./model";
import { DraftContext, MAX_RESTORE_TEXT, restoreProtected, sameContext } from "./restore";

const cl = classNameFactory("vc-draft-fork-");
let enabled = false;

export function setEnabled(value: boolean) {
    enabled = value;
}

interface Lease { active: boolean; requestClose?: () => void; }

export function openDraftFork(channelId: string) {
    const accountId = UserStore.getCurrentUser()?.id;
    if (!accountId || !enabled) return;
    const lease: Lease = { active: true };
    openModal(props => <SafeForkModal {...props} accountId={accountId} channelId={channelId} lease={lease} />, {
        modalKey: "DraftFork",
        onCloseRequest: () => {
            if (lease.requestClose) lease.requestClose();
            else {
                lease.active = false;
                closeModal("DraftFork");
            }
        },
        onCloseCallback: () => { lease.active = false; }
    });
}

interface ForkProps extends RenderModalProps {
    accountId: string;
    channelId: string;
    lease: Lease;
}

function ForkModal({ accountId, channelId, lease, ...props }: ForkProps) {
    const [history, setHistory] = useState<Revision[] | null>(null);
    const [selectedId, setSelectedId] = useState("");
    const [review, setReview] = useState<DraftContext | null>(null);
    const [label, setLabel] = useState("");
    const [variant, setVariant] = useState<{ parentId: string; text: string; label: string; } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [discarding, setDiscarding] = useState(false);
    const context = useStateFromStores(
        [UserStore, SelectedChannelStore, DraftStore, UploadAttachmentStore, PendingReplyStore, EditMessageStore],
        () => readContext(channelId), [channelId], sameContext
    );
    const selected = history?.find(item => item.id === selectedId);
    const changedSinceReview = review !== null && !sameContext(review, context);
    const changes = useMemo(() => selected && review ? diffLines(review.text, selected.text, { timeout: 40, maxEditLength: 2000 }) : undefined, [selected?.text, review?.text]);

    function finishClose() {
        lease.active = false;
        props.onClose();
    }

    function close() {
        if (variant) setDiscarding(true);
        else finishClose();
    }

    useLayoutEffect(() => {
        lease.requestClose = close;
        return () => { lease.requestClose = undefined; };
    });

    useEffect(() => {
        let active = true;
        lease.active = true;
        readHistory(accountId, channelId).then(items => {
            if (!active) return;
            setHistory(items);
            setSelectedId(items.at(-1)?.id ?? "");
            setReview(readContext(channelId));
        }).catch(() => {
            if (active) setError("Could not read the checkpoint history. Existing data was kept. Close and reopen DraftFork to try again.");
        });
        return () => { active = false; lease.active = false; };
    }, [accountId, channelId]);
    useEffect(() => {
        if (context.accountId !== accountId || context.channelId !== channelId) finishClose();
    }, [context.accountId, context.channelId, accountId, channelId]);

    async function run(action: () => Promise<void>) {
        if (busy || !lease.active || !enabled) return;
        setBusy(true);
        setError("");
        setNotice("");
        try { await action(); }
        catch (err) {
            if (lease.active) setError(err instanceof Error ? err.message : "Could not complete the action. Try again.");
        } finally {
            if (lease.active) setBusy(false);
        }
    }

    function showRevision(id: string) {
        setSelectedId(id);
        setReview(readContext(channelId));
        setVariant(null);
        setConfirmDelete(false);
        setError("");
        setNotice("");
    }

    async function checkpoint() {
        const current = readContext(channelId);
        if (current.accountId !== accountId || current.channelId !== channelId || current.blockedReason)
            throw new Error(current.blockedReason || "You are no longer in the original account and channel.");
        const revision: Revision = {
            id: crypto.randomUUID(), label: label.trim() || "Current draft", text: current.text,
            kind: "checkpoint", createdAt: Date.now()
        };
        const items = await changeHistory(accountId, channelId, previous => appendRevision(previous, revision));
        if (!lease.active) return;
        setHistory(items);
        setSelectedId(revision.id);
        setReview(readContext(channelId));
        setLabel("");
        setVariant(null);
        setNotice("Checkpoint saved. Your draft is unchanged.");
    }

    async function restore() {
        if (!selected || !review) return;
        try {
            const items = await restoreProtected(review, selected, {
                current: () => readContext(channelId),
                active: () => lease.active && enabled,
                saveRecovery: (before, target) => saveRecovery(accountId, channelId, before.text, target),
                apply: text => applyDraft(channelId, text)
            });
            if (!lease.active) return;
            setHistory(items);
            setReview(readContext(channelId));
            setNotice("Checkpoint restored. Your previous draft was saved as “Before restore”. Check the composer before sending.");
        } catch (err) {
            if (lease.active && readContext(channelId).accountId === accountId) {
                try {
                    const saved = await readHistory(accountId, channelId);
                    if (lease.active) setHistory(saved);
                } catch {
                    if (lease.active) setNotice("Could not reload the checkpoint history. Close and reopen DraftFork to check your recovery copies.");
                }
            }
            throw err;
        }
    }

    async function saveVariant() {
        if (!variant) return;
        const revision: Revision = {
            id: crypto.randomUUID(), label: variant.label.trim() || "New variant", text: variant.text,
            kind: "variant", parentId: variant.parentId, createdAt: Date.now()
        };
        const items = await changeHistory(accountId, channelId, previous => appendRevision(previous, revision));
        if (!lease.active) return;
        setHistory(items);
        setSelectedId(revision.id);
        setReview(readContext(channelId));
        setVariant(null);
        setDiscarding(false);
        setNotice("Variant saved. Restore it when you want to use it in the composer.");
    }

    if (context.accountId !== accountId || context.channelId !== channelId) return null;
    const unavailable = busy || history === null;
    const full = (history?.length ?? 0) >= MAX_REVISIONS;
    const channelName = ChannelStore.getChannel(channelId)?.name;
    const parent = selected?.parentId ? history?.find(item => item.id === selected.parentId) : undefined;
    return (
        <Modal {...props} onClose={close} title="DraftFork" size="xl" subtitle={channelName ? `Draft versions in #${channelName}` : "Draft versions in this conversation"} actions={[
            { text: "Export backup", variant: "secondary", disabled: unavailable, onClick: () => run(async () => {
                const revisions = await readHistory(accountId, channelId);
                if (!lease.active) return;
                const backup = { ...packHistory(revisions), accountId, channelId };
                saveFile(new File([JSON.stringify(backup, null, 2)], `DraftFork-${channelId}.json`, { type: "application/json" }));
            }) },
            { text: "Close", variant: "secondary", onClick: close }
        ]}>
            <div className={cl("root")} aria-busy={busy}>
                <p className={cl("intro")}>Save different versions of a draft and compare them before restoring. Text only; checkpoints are saved when you click.</p>
                <div className={cl("capture")}>
                    <TextInput value={label} onChange={setLabel} maxLength={MAX_LABEL} placeholder="Checkpoint name, e.g. Short reply" aria-label="Checkpoint name" disabled={unavailable || !!variant} />
                    <Button disabled={unavailable || !!context.blockedReason || !!variant || full || context.text.length > MAX_TEXT} onClick={() => run(checkpoint)}>Save checkpoint</Button>
                </div>
                <p className={cl("muted")}>{history === null ? "Loading checkpoints…" : `${history.length}/${MAX_REVISIONS} checkpoints in this channel. Restoring needs one free slot for a recovery copy.`}</p>
                {context.blockedReason ? <div className={cl("warning")} role="status">{context.blockedReason}</div> : null}
                {context.text.length > MAX_TEXT ? <p className={cl("warning")}>Your current draft exceeds {MAX_TEXT.toLocaleString("en-US")} characters. Shorten it before saving or restoring.</p> : null}
                {error ? <div className={cl("error")} role="alert">{error}</div> : null}
                {notice ? <div className={cl("notice")} role="status">{notice}</div> : null}
                {discarding ? <div className={cl("warning")} role="alert">
                    Your variant has not been saved. Discard it and close DraftFork?
                    <div className={cl("actions")}>
                        <Button variant="dangerPrimary" disabled={busy} onClick={finishClose}>Discard and close</Button>
                        <Button variant="secondary" onClick={() => setDiscarding(false)}>Keep editing</Button>
                    </div>
                </div> : null}
                <div className={cl("layout")}>
                    <section className={cl("history")} aria-label="Saved checkpoints">
                        <Heading tag="h3">Checkpoints</Heading>
                        {history?.length === 0 ? <p className={cl("muted")}>No checkpoints yet. Save your first draft above.</p> : null}
                        {history?.toReversed().map(item => <Button key={item.id} className={cl("revision")} variant={item.id === selectedId ? "primary" : "secondary"} disabled={unavailable || !!variant} aria-pressed={item.id === selectedId} onClick={() => showRevision(item.id)}>
                            <span>{item.label}</span>
                            <small>{item.kind === "recovery" ? "Recovery copy" : item.kind === "variant" ? "Variant" : "Manual checkpoint"} · {new Date(item.createdAt).toLocaleString("en-US")}</small>
                        </Button>)}
                    </section>
                    <section className={cl("detail")} aria-label="Compare and restore">
                        {selected ? <>
                            <Heading tag="h3">{selected.label}</Heading>
                            {selected.parentId ? <p className={cl("muted")}>Variant of: {parent?.label ?? "deleted checkpoint"}</p> : null}
                            <div className={cl("actions")}>
                                <Button variant="secondary" size="small" disabled={unavailable || !!variant || full} onClick={() => { setVariant({ parentId: selected.id, text: selected.text, label: "" }); setConfirmDelete(false); }}>Create variant</Button>
                                <Button variant="secondary" size="small" disabled={unavailable || !!variant} onClick={() => { setReview(readContext(channelId)); setError(""); }}>Refresh comparison</Button>
                                <Button variant="dangerSecondary" size="small" disabled={unavailable || !!variant} onClick={() => setConfirmDelete(true)}>Delete checkpoint</Button>
                            </div>
                            {confirmDelete ? <div className={cl("actions")} role="group" aria-label="Confirm checkpoint deletion">
                                <Button variant="dangerPrimary" size="small" disabled={unavailable} onClick={() => run(async () => {
                                    const items = await changeHistory(accountId, channelId, previous => removeRevision(previous, selected.id));
                                    if (!lease.active) return;
                                    setHistory(items);
                                    showRevision(items.at(-1)?.id ?? "");
                                })}>Delete this checkpoint</Button>
                                <Button variant="secondary" size="small" disabled={unavailable} onClick={() => setConfirmDelete(false)}>Keep checkpoint</Button>
                            </div> : null}
                            {variant ? <div className={cl("variant")}>
                                <Heading tag="h4">New variant</Heading>
                                <TextInput value={variant.label} onChange={value => setVariant({ ...variant, label: value })} maxLength={MAX_LABEL} aria-label="Variant name" placeholder="e.g. Detailed reply" disabled={unavailable} />
                                <TextArea value={variant.text} onChange={value => setVariant({ ...variant, text: value })} rows={9} maxLength={MAX_RESTORE_TEXT} aria-label="Variant text" disabled={unavailable} />
                                <p className={cl("muted")}>{variant.text.length.toLocaleString("en-US")}/{MAX_RESTORE_TEXT.toLocaleString("en-US")} characters. Unsaved variants are discarded if you switch accounts or channels.</p>
                                <div className={cl("actions")}>
                                    <Button disabled={unavailable || variant.text.length > MAX_RESTORE_TEXT} onClick={() => run(saveVariant)}>Save variant</Button>
                                    <Button variant="secondary" disabled={unavailable} onClick={() => { setVariant(null); setDiscarding(false); }}>Discard variant</Button>
                                </div>
                            </div> : <>
                                <p className={cl("legend")}><span className={cl("removed")}>− Remove from current draft</span><span className={cl("added")}>+ Add from selected checkpoint</span></p>
                                {changes ? <pre className={cl("diff")} tabIndex={0} aria-label="Line-by-line differences">{changes.map((part, index) => <span key={`${index}:${part.added}:${part.removed}`} className={cl(part.added ? "added" : part.removed ? "removed" : "same")}>{part.value}</span>)}</pre> : <div className={cl("fallback")}>
                                    <div><Heading tag="h4">Current draft when compared</Heading><pre>{review?.text || "(Empty)"}</pre></div>
                                    <div><Heading tag="h4">Selected checkpoint</Heading><pre>{selected.text || "(Empty)"}</pre></div>
                                </div>}
                                {selected.text === "" ? <p className={cl("warning")}>This checkpoint is empty. Restoring it will clear the composer after saving a recovery copy.</p> : null}
                                {selected.text.length > MAX_RESTORE_TEXT ? <p className={cl("warning")}>This checkpoint exceeds the {MAX_RESTORE_TEXT.toLocaleString("en-US")}-character restore limit. Create a shorter variant to restore; the original checkpoint will be kept.</p> : null}
                                {changedSinceReview ? <p className={cl("warning")} role="status">The draft or context changed. Select “Refresh comparison” to review it before restoring.</p> : null}
                                {review?.text === selected.text ? <p className={cl("muted")}>This checkpoint matches the draft being compared.</p> : null}
                                <Button disabled={unavailable || !!context.blockedReason || changedSinceReview || review === null || selected.text === review.text || selected.text.length > MAX_RESTORE_TEXT || full || context.text.length > MAX_TEXT} onClick={() => run(restore)}>Save current draft and restore</Button>
                            </>}
                        </> : <p className={cl("muted")}>Select or save a checkpoint to compare.</p>}
                    </section>
                </div>
                <p className={cl("muted")}>Checkpoints are stored per account and channel in Equicord&apos;s shared DataStore. They may be included in Equicord Cloud Sync V2 and backups. Exported JSON contains unsent text and account/channel IDs.</p>
            </div>
        </Modal>
    );
}

const SafeForkModal = ErrorBoundary.wrap(ForkModal);
