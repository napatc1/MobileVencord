/*
 * Ping Feed - a Vencord user plugin
 * Shows every channel you have an unread ping in - from every server - in the empty space under your
 * server list: the server's icon, the channel name and a red count. Click one to jump straight to the
 * ping (not the newest message). It disappears once you've read that channel.
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import {
    ActiveJoinedThreadsStore, ChannelStore, createRoot, FluxDispatcher, GuildChannelStore, GuildMemberStore,
    GuildReadStateStore, GuildStore, IconUtils, MessageStore, NavigationRouter, React, ReadStateStore, RestAPI, showToast, Tooltip,
    UserStore, useStateFromStores
} from "@webpack/common";

const settings = definePluginSettings({
    maxShown: {
        type: OptionType.SLIDER,
        description: "How many pinged channels to show under the server list",
        markers: [3, 5, 8, 12, 20],
        default: 8,
        stickToMarkers: true,
    },
    showChannelName: {
        type: OptionType.BOOLEAN,
        description: "Show the channel name under each server icon",
        default: true,
    },
});

// ── pings recorded live (exact message ids, so a click lands right on the ping) ──
const livePings = new Map<string, { ids: string[]; at: number; author?: string; text?: string; }>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

function pingsMe(m: any, guildId: string | undefined) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me || m?.author?.id === me) return false;
    if (m.mention_everyone) return true;
    if ((m.mentions ?? []).some((u: any) => (u?.id ?? u) === me)) return true;
    const roles: string[] = guildId ? GuildMemberStore.getMember(guildId, me)?.roles ?? [] : [];
    return (m.mention_roles ?? []).some((r: string) => roles.includes(r));
}

function onMessageCreate(e: any) {
    try {
        const m = e?.message;
        const channelId = e?.channelId ?? m?.channel_id;
        const guildId = e?.guildId ?? m?.guild_id ?? ChannelStore.getChannel(channelId)?.guild_id;
        if (!m?.id || !channelId || !guildId || e.optimistic) return;
        if (!pingsMe(m, guildId)) return;
        const entry = livePings.get(channelId) ?? { ids: [], at: 0 };
        if (!entry.ids.includes(m.id)) entry.ids.push(m.id);
        if (entry.ids.length > 50) entry.ids.shift();
        entry.at = Date.now();
        entry.author = m.member?.nick ?? m.author?.global_name ?? m.author?.username;
        entry.text = typeof m.content === "string" ? m.content.slice(0, 120) : undefined;
        livePings.set(channelId, entry);
        // let the read-state store count the mention first, then redraw
        setTimeout(emit, 0);
    } catch { }
}

// ── which channels have pings right now (Discord's own red-badge counts) ──
interface Ping {
    guildId: string;
    channelId: string;
    channelName: string;
    count: number;
    sortKey: number;
}

const snowflakeTime = (id?: string | null) => (id ? Number(BigInt(id) >> 22n) + 1420070400000 : 0);

function collectPings(): Ping[] {
    const out: Ping[] = [];
    const guilds = Object.values(GuildStore.getGuilds() ?? {}) as any[];
    for (const g of guilds) {
        if (!GuildReadStateStore.getMentionCount(g.id)) continue; // skip servers with no pings fast
        const data: any = GuildChannelStore.getChannels(g.id);
        const chans: any[] = [...(data?.SELECTABLE ?? []), ...(data?.VOCAL ?? [])].map(c => c?.channel ?? c);
        const threads = Object.values(ActiveJoinedThreadsStore.getActiveJoinedThreadsForGuild?.(g.id) ?? {})
            .flatMap((byParent: any) => Object.values(byParent ?? {}))
            .map((t: any) => t?.channel ?? t);
        for (const ch of [...chans, ...threads]) {
            if (!ch?.id) continue;
            const count = ReadStateStore.getMentionCount(ch.id);
            if (!count) continue;
            const live = livePings.get(ch.id);
            out.push({
                guildId: g.id,
                channelId: ch.id,
                channelName: ch.name ?? "channel",
                count,
                sortKey: live?.at || snowflakeTime(ReadStateStore.lastMessageId(ch.id)),
            });
        }
    }
    // forget recorded pings for channels you've read
    for (const id of [...livePings.keys()]) if (!ReadStateStore.getMentionCount(id)) livePings.delete(id);
    return out.sort((a, b) => b.sortKey - a.sortKey); // newest ping first
}

const samePings = (a: Ping[], b: Ping[]) =>
    a.length === b.length && a.every((x, i) => x.channelId === b[i].channelId && x.count === b[i].count);

function usePings() {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);
    return useStateFromStores([ReadStateStore, GuildReadStateStore, GuildChannelStore], collectPings, [], samePings);
}

// ── finding the exact ping ──
async function search(guildId: string, query: Record<string, string | number | boolean>): Promise<any[]> {
    const run = () => RestAPI.get({ url: `/guilds/${guildId}/messages/search`, query });
    let res: any = await run();
    if (res?.status === 202) { // Discord is still indexing that channel
        await new Promise(r => setTimeout(r, 1500));
        res = await run();
    }
    const groups: any[] = res?.body?.messages ?? [];
    return groups.map(g => (Array.isArray(g) ? g.find(m => m?.hit) ?? g[0] : g)).filter(Boolean);
}

const older = (a: string | null, b: string | null) => (!a ? b : !b ? a : BigInt(a) < BigInt(b) ? a : b);

async function findPing(guildId: string, channelId: string): Promise<string | null> {
    const lastRead = ReadStateStore.ackMessageId(channelId);
    const after = (id: string) => !lastRead || BigInt(id) > BigInt(lastRead);
    // no network: pings we saw arrive, or messages Discord already has loaded
    let best: string | null = null;
    for (const id of livePings.get(channelId)?.ids ?? []) if (after(id)) best = older(best, id);
    for (const m of ((MessageStore.getMessages(channelId) as any)?._array ?? []) as any[])
        if (m?.id && after(m.id) && pingsMe(m, guildId)) best = older(best, m.id);
    if (best) return best;
    // otherwise ask Discord's search, all at once (one round trip)
    const me = UserStore.getCurrentUser()?.id;
    const quiet = (q: Promise<any[]>) => q.catch(() => [] as any[]);
    const base: Record<string, string | number | boolean> = { channel_id: channelId, sort_by: "timestamp", sort_order: "asc" };
    if (lastRead) base.min_id = lastRead;
    const [unread, named, everyone] = await Promise.all([
        quiet(search(guildId, base)),
        quiet(search(guildId, { ...base, mentions: me })),
        quiet(search(guildId, { ...base, mention_everyone: true })),
    ]);
    for (const m of unread) if (pingsMe(m, guildId)) best = older(best, m.id);
    if (named[0]) best = older(best, named[0].id);
    if (everyone[0]) best = older(best, everyone[0].id);
    return best ?? ReadStateStore.getOldestUnreadMessageId(channelId) ?? lastRead ?? null;
}

async function jump(p: Ping) {
    const quick = livePings.get(p.channelId)?.ids.length;
    if (!quick) showToast({ text: `Finding the ping in #${p.channelName}…`, variant: "secondary" });
    const id = await findPing(p.guildId, p.channelId);
    NavigationRouter.transitionTo(`/channels/${p.guildId}/${p.channelId}${id ? "/" + id : ""}`);
}

// ── UI ──
const badge: React.CSSProperties = {
    position: "absolute", right: -4, bottom: -4, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8,
    background: "var(--status-danger, #f23f43)", color: "#fff", fontSize: 11, fontWeight: 800, lineHeight: "16px",
    textAlign: "center", boxShadow: "0 0 0 3px var(--background-tertiary, #1e1f22)", boxSizing: "border-box",
};

function Tile({ p }: { p: Ping; }) {
    const g: any = GuildStore.getGuild(p.guildId);
    const icon = g?.icon ? IconUtils.getGuildIconURL({ id: g.id, icon: g.icon, canAnimate: false, size: 96 }) : null;
    const initials = (g?.name ?? "?").split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3);
    const live = livePings.get(p.channelId);
    const tip = `${g?.name ?? "Server"} · #${p.channelName}` + (live?.author ? `\n${live.author}: ${live.text || "(attachment)"}` : "");
    return (
        <Tooltip text={tip} position="right">
            {(tp: any) => (
                <div
                    {...tp}
                    role="button"
                    tabIndex={0}
                    onClick={() => jump(p)}
                    style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", width: 64, marginBottom: 8 }}
                >
                    <div style={{ position: "relative", width: 40, height: 40 }}>
                        {icon
                            ? <img src={icon} alt="" style={{ width: 40, height: 40, borderRadius: 12, objectFit: "cover", display: "block" }} />
                            : <div style={{ width: 40, height: 40, borderRadius: 12, background: "var(--background-primary)", color: "var(--header-primary)", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{initials}</div>}
                        <span style={badge}>{p.count > 99 ? "99+" : p.count}</span>
                    </div>
                    {settings.store.showChannelName && (
                        <div style={{ maxWidth: 64, color: "var(--text-normal, #dbdee1)", fontSize: 10, fontWeight: 600, lineHeight: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            #{p.channelName}
                        </div>
                    )}
                </div>
            )}
        </Tooltip>
    );
}

function PingFeed() {
    const pings = usePings();
    if (!pings.length) return null;
    const max = settings.store.maxShown;
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", paddingTop: 6 }}>
            <div style={{ width: 32, height: 2, borderRadius: 1, background: "var(--background-modifier-accent, #3f4147)", marginBottom: 8 }} />
            <div style={{ color: "var(--status-danger, #f23f43)", fontSize: 10, fontWeight: 800, letterSpacing: ".05em", marginBottom: 6 }}>PINGS</div>
            {pings.slice(0, max).map(p => <Tile key={p.channelId} p={p} />)}
            {pings.length > max && <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, marginBottom: 8 }}>+{pings.length - max}</div>}
        </div>
    );
}

// ── keep our box right under the last button of the server list (+ / Discover) ──
// Found by Discord's keyboard-navigation ids, not class names (those change every update).
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let observer: MutationObserver | null = null;
let scheduled = 0;

function anchor(): Element | null {
    const last = document.querySelector('[data-list-item-id="guildsnav___guild-discover-button"]')
        ?? document.querySelector('[data-list-item-id="guildsnav___create-join-button"]');
    if (!last) return null;
    // climb to the wrapper that sits next to the servers (stop when a sibling holds server items)
    let el: Element = last;
    while (el.parentElement) {
        const sibs = Array.from(el.parentElement.children);
        if (sibs.some(s => s !== el && s.querySelector?.('[data-list-item-id^="guildsnav___"]'))) return el;
        el = el.parentElement;
    }
    return null;
}

function ensureHost() {
    scheduled = 0;
    const a = anchor();
    if (!a?.parentElement) return;
    if (host?.isConnected && host.previousElementSibling === a) return;
    if (!host) {
        host = document.createElement("div");
        host.id = "vc-pingfeed";
        host.style.cssText = "display:flex;justify-content:center;width:100%;";
        root = createRoot(host);
        root.render(<ErrorBoundary noop><PingFeed /></ErrorBoundary>);
    }
    a.parentElement.insertBefore(host, a.nextSibling);
}

export default definePlugin({
    name: "PingFeed",
    description: "Every unread ping, from every server, under your server list: server icon, channel and a red count. Click to jump straight to the ping.",
    authors: [{ name: "napatc1", id: 0n }],
    settings,

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
        observer?.disconnect();
        observer = null;
        if (scheduled) cancelAnimationFrame(scheduled);
        scheduled = 0;
        root?.unmount();
        root = null;
        host?.remove();
        host = null;
        livePings.clear();
    },
});
