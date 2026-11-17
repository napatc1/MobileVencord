/*
 * Ping Box - a Vencord user plugin
 * Shows the channels in the current server where you were pinged (any category) and jumps straight
 * to the ping - not to the newest message - when you click one.
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import {
    ChannelStore, createRoot, FluxDispatcher, MessageStore, GuildChannelStore, GuildMemberStore, Modal, NavigationRouter, openModal, ReadStateStore,
    RestAPI, SelectedGuildStore, showToast, UserStore, useStateFromStores
} from "@webpack/common";

const settings = definePluginSettings({
    showTopBox: {
        type: OptionType.BOOLEAN,
        description: "Show the pinged channels in a box at the top of the channel list",
        default: true,
    },
    showButtonWithoutPings: {
        type: OptionType.BOOLEAN,
        description: "Keep the @ button in the message bar even when there are no pings in this server",
        default: false,
    },
});

interface PingedChannel {
    id: string;
    name: string;
    category?: string;
    count: number;
    position: number;
}

function pingedChannels(guildId: string | null | undefined): PingedChannel[] {
    if (!guildId) return [];
    const data: any = GuildChannelStore.getChannels(guildId);
    const list: any[] = [...(data?.SELECTABLE ?? []), ...(data?.VOCAL ?? [])];
    const out: PingedChannel[] = [];
    for (const entry of list) {
        const ch = entry?.channel ?? entry;
        if (!ch?.id) continue;
        const count = ReadStateStore.getMentionCount(ch.id);
        if (!count) continue;
        const parent = ch.parent_id ? ChannelStore.getChannel(ch.parent_id) : null;
        out.push({ id: ch.id, name: ch.name ?? "channel", category: parent?.name, count, position: ch.position ?? 0 });
    }
    return out.sort((a, b) => b.count - a.count || a.position - b.position);
}

// ── finding the ping ──────────────────────────────────────────────────────
interface SearchMessage {
    id: string;
    hit?: boolean;
    mentions?: { id: string; }[];
    mention_roles?: string[];
    mention_everyone?: boolean;
}

async function search(guildId: string, query: Record<string, string | number | boolean>): Promise<SearchMessage[]> {
    const run = () => RestAPI.get({ url: `/guilds/${guildId}/messages/search`, query });
    let res: any = await run();
    // Discord answers 202 while it is still indexing a channel
    if (res?.status === 202) {
        await new Promise(r => setTimeout(r, 1500));
        res = await run();
    }
    const groups: any[] = res?.body?.messages ?? [];
    return groups.map(g => (Array.isArray(g) ? g.find(m => m?.hit) ?? g[0] : g)).filter(Boolean);
}

function pingsMe(m: SearchMessage, myId: string, myRoles: string[]) {
    return !!m.mention_everyone
        || (m.mentions ?? []).some(u => u?.id === myId)
        || (m.mention_roles ?? []).some(r => myRoles.includes(r));
}

const newerThan = (a: string, b?: string | null) => !b || BigInt(a) > BigInt(b);
const olderOf = (a: string | null, b: string | null) => (!a ? b : !b ? a : newerThan(a, b) ? b : a);

// ── fast paths, no network: pings recorded as they arrive + messages already loaded ──
const livePings = new Map<string, string[]>();
function onMessageCreate(e: any) {
    try {
        const m = e?.message;
        const channelId = e?.channelId ?? m?.channel_id;
        const guildId = e?.guildId ?? m?.guild_id;
        const myId = UserStore.getCurrentUser()?.id;
        if (!m?.id || !guildId || e.optimistic || m.author?.id === myId) return;
        if (!pingsMe(m, myId, GuildMemberStore.getMember(guildId, myId)?.roles ?? [])) return;
        const list = livePings.get(channelId) ?? [];
        if (!list.includes(m.id)) list.push(m.id);
        if (list.length > 50) list.shift();
        livePings.set(channelId, list);
    } catch { }
}

function knownPing(guildId: string, channelId: string, ack: string | null): string | null {
    const myId = UserStore.getCurrentUser()?.id;
    const myRoles = GuildMemberStore.getMember(guildId, myId)?.roles ?? [];
    let best: string | null = null;
    for (const id of livePings.get(channelId) ?? []) if (newerThan(id, ack)) best = olderOf(best, id);
    const loaded: any[] = (MessageStore.getMessages(channelId) as any)?._array ?? [];
    for (const m of loaded) {
        if (m?.id && newerThan(m.id, ack) && m.author?.id !== myId && pingsMe(m, myId, myRoles)) best = olderOf(best, m.id);
    }
    return best;
}

// ── searching: all at once, and remembered so a second click is instant ──
const found = new Map<string, { ack: string | null; id: string; }>();
const inFlight = new Map<string, Promise<{ id: string; how: string; } | null>>();

/** Oldest unread message that pings you (name, @everyone/@here or one of your roles), then fallbacks. */
function findPing(guildId: string, channelId: string): Promise<{ id: string; how: string; } | null> {
    const lastRead = ReadStateStore.ackMessageId(channelId);
    const quick = knownPing(guildId, channelId, lastRead);
    if (quick) return Promise.resolve({ id: quick, how: "already loaded" });
    const f = found.get(channelId);
    if (f && f.ack === lastRead) return Promise.resolve({ id: f.id, how: "found earlier" });
    const running = inFlight.get(channelId);
    if (running) return running;

    const p = (async () => {
        const myId = UserStore.getCurrentUser()?.id;
        const myRoles = GuildMemberStore.getMember(guildId, myId)?.roles ?? [];
        const quiet = (q: Promise<SearchMessage[]>) => q.catch(e => (console.warn("[PingBox] search failed", e), [] as SearchMessage[]));
        const base: Record<string, string | number | boolean> = { channel_id: channelId, sort_by: "timestamp", sort_order: "asc" };
        if (lastRead) base.min_id = lastRead;
        // one round trip instead of up to six one after another
        const [unread, named, everyone] = await Promise.all([
            quiet(search(guildId, base)),
            quiet(search(guildId, { ...base, mentions: myId })),
            quiet(search(guildId, { ...base, mention_everyone: true })),
        ]);
        let best: string | null = null;
        for (const m of unread) if (pingsMe(m, myId, myRoles)) best = olderOf(best, m.id);
        if (named[0]) best = olderOf(best, named[0].id);
        if (everyone[0]) best = olderOf(best, everyone[0].id);
        if (best) return { id: best, how: "oldest unread ping" };
        // a role ping further down: keep paging the unread messages
        if (lastRead && unread.length >= 25) {
            for (let offset = 25; offset < 100; offset += 25) {
                const page = await quiet(search(guildId, { ...base, offset }));
                const hit = page.find(m => pingsMe(m, myId, myRoles));
                if (hit) return { id: hit.id, how: "oldest unread ping" };
                if (page.length < 25) break;
            }
        }
        const newest = await quiet(search(guildId, { channel_id: channelId, mentions: myId }));
        if (newest[0]) return { id: newest[0].id, how: "newest ping" };
        const oldestUnread = ReadStateStore.getOldestUnreadMessageId(channelId);
        if (oldestUnread) return { id: oldestUnread, how: "first unread" };
        return lastRead ? { id: lastRead, how: "where you stopped reading" } : null;
    })().then(r => {
        if (r) found.set(channelId, { ack: lastRead, id: r.id });
        inFlight.delete(channelId);
        return r;
    }, () => (inFlight.delete(channelId), null));
    inFlight.set(channelId, p);
    return p;
}

/** Look up the top few pings in the background (spaced out: Discord rate-limits search). */
const prefetched = new Map<string, string | null>();
function prefetch(guildId: string, pings: PingedChannel[]) {
    pings.slice(0, 3).forEach((ch, i) => {
        const ack = ReadStateStore.ackMessageId(ch.id);
        if (prefetched.has(ch.id) && prefetched.get(ch.id) === ack) return;
        prefetched.set(ch.id, ack);
        if (knownPing(guildId, ch.id, ack)) return;
        setTimeout(() => void findPing(guildId, ch.id), 300 + i * 800);
    });
}

async function jumpToPing(guildId: string, ch: PingedChannel, close: () => void) {
    const ack = ReadStateStore.ackMessageId(ch.id);
    const ready = knownPing(guildId, ch.id, ack) || found.get(ch.id)?.ack === ack;
    if (!ready) showToast({ text: `Finding the ping in #${ch.name}…`, variant: "secondary" });
    const hit = await findPing(guildId, ch.id);
    close();
    if (!hit) {
        showToast({ text: `Couldn't find the exact ping in #${ch.name} - opened the channel`, variant: "critical" });
        NavigationRouter.transitionTo(`/channels/${guildId}/${ch.id}`);
        return;
    }
    // On desktop, a message URL opens the chat at that message and highlights it
    NavigationRouter.transitionTo(`/channels/${guildId}/${ch.id}/${hit.id}`);
}

// ── UI ────────────────────────────────────────────────────────────────────
const AtIcon = ({ height = 20, width = 20, className }: { height?: number; width?: number; className?: string; }) => (
    <svg aria-hidden="true" width={width} height={height} viewBox="0 0 24 24" className={className}>
        <path
            fill="currentColor"
            d="M12 2a10 10 0 1 0 5.35 18.45 1 1 0 1 0-1.07-1.69A8 8 0 1 1 20 12v1.25a1.75 1.75 0 0 1-3.5 0V8a1 1 0 1 0-2 0v.3A5 5 0 1 0 15.1 15a3.75 3.75 0 0 0 6.9-1.75V12A10 10 0 0 0 12 2Zm0 13a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
        />
    </svg>
);

function useGuildPings() {
    const guildId = useStateFromStores([SelectedGuildStore], () => SelectedGuildStore.getGuildId());
    // recompute whenever read states change (new mention / channel read)
    const pings = useStateFromStores(
        [ReadStateStore, GuildChannelStore],
        () => pingedChannels(guildId),
        [guildId],
        (a: PingedChannel[], b: PingedChannel[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.count === b[i].count)
    );
    return { guildId, pings };
}

function PingBoxModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const { guildId, pings } = useGuildPings();
    return (
        <Modal {...modalProps} title="Pings in this server" size="sm">
            <div style={{ padding: "4px 0 12px" }}>
                {!pings.length && <div style={{ color: "var(--text-muted)", padding: 8 }}>No pings here 🎉</div>}
                {pings.map(ch => (
                    <div
                        key={ch.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => guildId && jumpToPing(guildId, ch, modalProps.onClose)}
                        style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8,
                            cursor: "pointer", background: "var(--background-modifier-hover)", marginBottom: 6,
                        }}
                    >
                        <span style={{ color: "var(--text-muted)", fontSize: 18 }}>#</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: "var(--header-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</div>
                            {ch.category && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{ch.category}</div>}
                        </div>
                        <span style={{ minWidth: 22, height: 22, padding: "0 6px", borderRadius: 11, background: "var(--status-danger)", color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {ch.count > 99 ? "99+" : ch.count}
                        </span>
                    </div>
                ))}
            </div>
        </Modal>
    );
}

function PingTopBox() {
    const { guildId, pings } = useGuildPings();
    if (!settings.store.showTopBox || !guildId || !pings.length) return null;
    prefetch(guildId, pings);
    return (
        <div style={{ margin: "8px 8px 4px", padding: "6px 0", borderRadius: 10, background: "var(--background-secondary-alt, var(--background-tertiary))", border: "1px solid var(--background-modifier-accent)" }}>
            <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 800, letterSpacing: ".04em", padding: "0 10px 4px" }}>PINGS</div>
            {pings.slice(0, 8).map(ch => (
                <div
                    key={ch.id}
                    role="button"
                    tabIndex={0}
                    title={`Jump to the ping in #${ch.name}`}
                    onClick={() => jumpToPing(guildId, ch, () => { })}
                    className="vc-pingbox-row"
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", cursor: "pointer", borderRadius: 6 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--background-modifier-hover)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                    <span style={{ color: "var(--channel-icon, var(--text-muted))", fontSize: 16, width: 12 }}>#</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: "var(--interactive-active, var(--header-primary))", fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</div>
                        {ch.category && <div style={{ color: "var(--text-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.category}</div>}
                    </div>
                    <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: "var(--status-danger)", color: "#fff", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {ch.count > 99 ? "99+" : ch.count}
                    </span>
                </div>
            ))}
            {pings.length > 8 && <div style={{ color: "var(--text-muted)", fontSize: 11, padding: "2px 10px" }}>+{pings.length - 8} more</div>}
        </div>
    );
}

// Keep our own container right above the channel list. The list is found by its rows
// (data-list-item-id="channels___…", which Discord uses for keyboard navigation) instead of class
// names, which change with every Discord update.
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let observer: MutationObserver | null = null;
let scheduled = 0;

function ensureHost() {
    scheduled = 0;
    const row = document.querySelector('[data-list-item-id^="channels___"]');
    const list = row?.closest("ul");
    if (!list?.parentElement) return;
    if (host?.isConnected && host.nextElementSibling === list) return;
    if (!host) {
        host = document.createElement("div");
        host.id = "vc-pingbox-top";
        root = createRoot(host);
        root.render(<ErrorBoundary noop><PingTopBox /></ErrorBoundary>);
    }
    list.parentElement.insertBefore(host, list);
}

const PingBoxButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const { pings } = useGuildPings();
    if (!isMainChat) return null;
    if (!pings.length && !settings.store.showButtonWithoutPings) return null;
    const total = pings.reduce((a, c) => a + c.count, 0);
    return (
        <ChatBarButton
            tooltip={pings.length ? `Pings in ${pings.length} channel${pings.length === 1 ? "" : "s"}` : "No pings in this server"}
            onClick={() => openModal(props => <ErrorBoundary><PingBoxModal modalProps={props} /></ErrorBoundary>)}
        >
            <div style={{ position: "relative", display: "flex" }}>
                <AtIcon />
                {total > 0 && (
                    <span style={{ position: "absolute", right: -8, bottom: -6, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--status-danger)", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {total > 99 ? "99+" : total}
                    </span>
                )}
            </div>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "PingBox",
    description: "Pinged channels at the top of the channel list (and an @ button in the message bar). Click one to jump straight to the ping, not the newest message.",
    authors: [{ name: "napatc1", id: 0n }],
    settings,
    chatBarButton: {
        icon: AtIcon,
        render: PingBoxButton,
    },

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        observer = new MutationObserver(() => {
            if (!scheduled) scheduled = requestAnimationFrame(ensureHost);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        ensureHost();
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        livePings.clear();
        found.clear();
        prefetched.clear();
        observer?.disconnect();
        observer = null;
        if (scheduled) cancelAnimationFrame(scheduled);
        scheduled = 0;
        root?.unmount();
        root = null;
        host?.remove();
        host = null;
    },
});
