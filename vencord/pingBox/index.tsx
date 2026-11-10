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
    ChannelStore, GuildChannelStore, GuildMemberStore, Modal, NavigationRouter, openModal, ReadStateStore,
    RestAPI, SelectedGuildStore, showToast, UserStore, useStateFromStores
} from "@webpack/common";

const settings = definePluginSettings({
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

/** Oldest unread message that pings you (name, @everyone/@here or one of your roles), then fallbacks. */
async function findPing(guildId: string, channelId: string): Promise<{ id: string; how: string; } | null> {
    const myId = UserStore.getCurrentUser()?.id;
    const myRoles = GuildMemberStore.getMember(guildId, myId)?.roles ?? [];
    const lastRead = ReadStateStore.ackMessageId(channelId);

    try {
        if (lastRead) {
            for (let offset = 0; offset < 100; offset += 25) {
                const page = await search(guildId, { channel_id: channelId, min_id: lastRead, sort_by: "timestamp", sort_order: "asc", offset });
                const hit = page.find(m => pingsMe(m, myId, myRoles));
                if (hit) return { id: hit.id, how: "oldest unread ping" };
                if (page.length < 25) break;
            }
        }
        const named = await search(guildId, { channel_id: channelId, mentions: myId });
        if (named[0]) return { id: named[0].id, how: "newest ping" };
        const everyone = await search(guildId, { channel_id: channelId, mention_everyone: true });
        if (everyone[0]) return { id: everyone[0].id, how: "newest @everyone" };
    } catch (e) {
        console.warn("[PingBox] search failed", e);
    }
    const oldestUnread = ReadStateStore.getOldestUnreadMessageId(channelId);
    if (oldestUnread) return { id: oldestUnread, how: "first unread" };
    return lastRead ? { id: lastRead, how: "where you stopped reading" } : null;
}

async function jumpToPing(guildId: string, ch: PingedChannel, close: () => void) {
    showToast({ text: `Finding the ping in #${ch.name}…`, variant: "secondary" });
    const found = await findPing(guildId, ch.id);
    close();
    if (!found) {
        showToast({ text: `Couldn't find the exact ping in #${ch.name} - opened the channel`, variant: "critical" });
        NavigationRouter.transitionTo(`/channels/${guildId}/${ch.id}`);
        return;
    }
    // On desktop, a message URL opens the chat at that message and highlights it
    NavigationRouter.transitionTo(`/channels/${guildId}/${ch.id}/${found.id}`);
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
    description: "An @ button in the message bar listing the channels in this server where you were pinged. Click one to jump straight to the ping, not the newest message.",
    authors: [{ name: "napatc1", id: 0n }],
    settings,
    chatBarButton: {
        icon: AtIcon,
        render: PingBoxButton,
    },
});
