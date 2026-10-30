/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const values = new Map();
let tail = Promise.resolve();
let gate;
let fail = false;
export function reset() { values.clear(); tail = Promise.resolve(); gate = undefined; fail = false; }
export function seed(account, channel, revisions) { values.set(`DraftFork_v1_${account}_${channel}`, { plugin: "DraftFork", version: 1, revisions: structuredClone(revisions) }); }
export function history(account = "account-a", channel = "channel-a") { return structuredClone(values.get(`DraftFork_v1_${account}_${channel}`)?.revisions ?? []); }
export function corrupt() { values.set("DraftFork_v1_account-a_channel-a", { broken: true }); }
export function holdNextUpdate() {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    gate = wait;
    return release;
}
export function failNextUpdate() { fail = true; }
export async function get(key) { return structuredClone(values.get(key)); }
export function update(key, change) {
    const wait = gate;
    gate = undefined;
    const operation = tail.then(async () => {
        if (wait) await wait;
        const next = change(structuredClone(values.get(key)));
        if (fail) { fail = false; throw new Error("Storage unavailable"); }
        values.set(key, structuredClone(next));
    });
    tail = operation.catch(() => {});
    return operation;
}
