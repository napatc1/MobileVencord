/*
 * Read As You Go - a Vencord user plugin
 * Marks a channel as read only up to the newest message you have actually had on screen, as you
 * scroll - so you don't have to scroll all the way to the bottom, and nothing you haven't seen is
 * marked read.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, ReadStateStore, SelectedChannelStore } from "@webpack/common";

const settings = definePluginSettings({
    visiblePercent: {
        type: OptionType.SLIDER,
        description: "How much of a message must be on screen to count as seen (%)",
        markers: [25, 50, 75, 100],
        default: 60,
        stickToMarkers: true,
    },
    delayMs: {
        type: OptionType.SLIDER,
        description: "Wait this long after scrolling before marking as read (ms)",
        markers: [300, 800, 1500, 3000],
        default: 800,
        stickToMarkers: true,
    },
});

// message list items look like <li id="chat-messages-{channelId}-{messageId}">
const ID_PREFIX = "chat-messages-";
const parseId = (id: string) => {
    if (!id.startsWith(ID_PREFIX)) return null;
    const [channelId, messageId] = id.slice(ID_PREFIX.length).split("-");
    return channelId && messageId && /^\d+$/.test(messageId) ? { channelId, messageId } : null;
};
const newer = (a: string, b: string | null | undefined) => !b || BigInt(a) > BigInt(b);

let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;
let pending: { channelId: string; messageId: string; } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const observed = new WeakSet<Element>();

function flush() {
    timer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    // only while you're actually looking at this channel in a focused window
    if (!document.hasFocus() || document.visibilityState !== "visible") return;
    if (SelectedChannelStore.getChannelId() !== p.channelId) return;
    const acked = ReadStateStore.ackMessageId(p.channelId);
    if (!newer(p.messageId, acked)) return; // already read this far
    // never claim to have read past the channel's newest message
    const last = ReadStateStore.lastMessageId(p.channelId);
    if (last && newer(p.messageId, last)) return;
    // Discord's own bulk-ack action (the same one Vencord's ReadAllNotificationsButton uses)
    FluxDispatcher.dispatch({
        type: "BULK_ACK",
        context: "APP",
        channels: [{ channelId: p.channelId, messageId: p.messageId, readStateType: 0 }],
    });
}

function onSeen(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
        if (!e.isIntersecting) continue;
        const ids = parseId((e.target as HTMLElement).id);
        if (!ids) continue;
        if (!pending || pending.channelId !== ids.channelId) pending = ids;
        else if (newer(ids.messageId, pending.messageId)) pending = ids;
    }
    if (pending) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, settings.store.delayMs);
    }
}

function observeAll(root: ParentNode) {
    if (!io) return;
    root.querySelectorAll?.(`li[id^="${ID_PREFIX}"]`).forEach(el => {
        if (observed.has(el)) return;
        observed.add(el);
        io!.observe(el);
    });
}

function start() {
    io = new IntersectionObserver(onSeen, { threshold: Math.min(1, Math.max(0.05, settings.store.visiblePercent / 100)) });
    observeAll(document);
    // new messages load in as you scroll (and when you switch channels)
    mo = new MutationObserver(muts => {
        for (const m of muts) m.addedNodes.forEach(n => n instanceof Element && (n.id?.startsWith(ID_PREFIX) ? observeAll(n.parentNode ?? n) : observeAll(n)));
    });
    mo.observe(document.body, { childList: true, subtree: true });
}

function stop() {
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
}

export default definePlugin({
    name: "ReadAsYouGo",
    description: "Marks messages as read up to the newest one you've actually seen as you scroll - no need to scroll to the bottom, and nothing unseen gets marked read.",
    authors: [{ name: "napatc1", id: 0n }],
    settings,
    start,
    stop,
});
