(() => {
    "use strict";
    // Ping Box: a box at the top of every server's channel list showing the channels where you were
    // pinged (any category), with counts. Tap one to jump straight to the ping, not to the newest message.
    // Every Discord lookup is guarded and looked up when needed, never at plugin start.

    const { metro, patcher, plugin } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative } = metro.common;
    const { View, Text, Pressable, Linking } = ReactNative;
    const h = React.createElement;

    const VERSION = "1.0.0";
    const COLORS = { text: "#E3E8F4", sub: "#8592AD", muted: "#576175", box: "#1C1F26", border: "#2B303B", red: "#CA6E8C", ring: "#16181D" };
    const CHANNEL_LIST = "modules/channel_list_v2/native/RedesignChannelList.tsx";

    const safe = (fn, fb) => {
        try {
            const r = fn();
            return r === undefined ? fb : r;
        } catch (e) {
            return fb;
        }
    };
    const toast = (m) => safe(() => vendetta.ui.toasts.showToast(m));
    const status = { hook: "not started", boxRenders: 0, lastJump: "none", channelsSource: "?" };
    const unpatches = [];

    // lazy store / module lookups
    const cache = {};
    const store = (name) => cache[name] || (cache[name] = safe(() => metro.findByStoreName(name), null));
    const props = (key, ...p) => cache[key] || (cache[key] = safe(() => metro.findByProps(...p), null));

    function exportsByPath(path) {
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        for (const id in mods) {
            const m = mods[id];
            if (m && m.__filePath === path) return safe(() => m.publicModule.exports, null);
        }
        return null;
    }

    // ── which channels in this server have pings ───────────────────────────
    function guildChannels(guildId) {
        // 1) GuildChannelStore.getChannels(gid) -> { SELECTABLE: [{ channel }], VOCAL: [...] }
        const gcs = safe(() => store("GuildChannelStore").getChannels(guildId), null);
        if (gcs && (gcs.SELECTABLE || gcs.VOCAL)) {
            status.channelsSource = "GuildChannelStore";
            return [].concat(gcs.SELECTABLE || [], gcs.VOCAL || []).map((x) => (x && x.channel) || x).filter(Boolean);
        }
        // 2) ChannelStore.getMutableGuildChannelsForGuild(gid) -> { id: channel }
        const map = safe(() => store("ChannelStore").getMutableGuildChannelsForGuild(guildId), null);
        if (map && typeof map === "object") {
            status.channelsSource = "ChannelStore";
            return Object.values(map);
        }
        status.channelsSource = "none found";
        return [];
    }
    const mentionCount = (channelId) => {
        const n = safe(() => store("ReadStateStore").getMentionCount(channelId), 0);
        return typeof n === "number" && n > 0 ? n : 0;
    };
    function pingedChannels(guildId) {
        if (!guildId) return [];
        const out = [];
        for (const ch of guildChannels(guildId)) {
            const n = mentionCount(ch.id);
            if (!n) continue;
            const parent = ch.parent_id ? safe(() => store("ChannelStore").getChannel(ch.parent_id), null) : null;
            out.push({ id: ch.id, name: ch.name || "channel", category: parent && parent.name, count: n, position: ch.position || 0 });
        }
        return out.sort((a, b) => b.count - a.count || a.position - b.position);
    }

    // ── finding the ping and jumping to it ─────────────────────────────────
    const me = () => safe(() => store("UserStore").getCurrentUser().id, null);

    // returns a Promise of { id, how } or null (plain promises: no async/await for Hermes runtime eval)
    function findPingMessageId(guildId, channelId) {
        // a) mentions Discord already has in memory
        const recent = safe(() => {
            const rm = store("RecentMentionsStore");
            const list = (rm.getMentions && rm.getMentions()) || [];
            const hit = list.find((m) => (m.channel_id || m.channelId) === channelId);
            return hit && hit.id;
        }, null);
        if (recent) return Promise.resolve({ id: recent, how: "recent mentions" });
        const firstUnread = () => {
            // c) role/@everyone pings aren't in a "mentions" search: fall back to the first unread message
            const unread = safe(() => {
                const rs = store("ReadStateStore");
                return (rs.getOldestUnreadMessageId && rs.getOldestUnreadMessageId(channelId)) || null;
            }, null);
            return unread ? { id: unread, how: "first unread" } : null;
        };
        // b) Discord's own message search: newest message in this channel that mentions you
        const uid = me();
        const HTTP = safe(() => props("http", "HTTP").HTTP, null) || props("http2", "get", "post", "patch", "del");
        if (!uid || !HTTP || typeof HTTP.get !== "function") {
            status.lastSearch = "no search available";
            return Promise.resolve(firstUnread());
        }
        let req;
        try {
            req = HTTP.get({ url: `/guilds/${guildId}/messages/search`, query: { mentions: uid, channel_id: channelId } });
        } catch (e) {
            status.lastSearch = `search failed: ${(e && e.message) || e}`;
            return Promise.resolve(firstUnread());
        }
        return Promise.resolve(req).then(
            (res) => {
                const body = (res && res.body) || {};
                const first = body.messages && body.messages[0] && (Array.isArray(body.messages[0]) ? body.messages[0][0] : body.messages[0]);
                if (first && first.id) return { id: first.id, how: "search" };
                status.lastSearch = `search returned ${body.total_results != null ? body.total_results : "?"} results`;
                return firstUnread();
            },
            (e) => {
                status.lastSearch = `search failed: ${(e && (e.status || e.message)) || e}`;
                return firstUnread();
            },
        );
    }

    function navigate(guildId, channelId, messageId) {
        const tries = [
            ["jumpToMessage", () => props("jump", "jumpToMessage").jumpToMessage({ channelId, messageId, flash: true })],
            ["transitionTo", () => props("trans", "transitionTo").transitionTo(`/channels/${guildId}/${channelId}/${messageId}`)],
            ["deep link", () => Linking.openURL(`discord://-/channels/${guildId}/${channelId}/${messageId}`)],
        ];
        for (const [name, fn] of tries) {
            try {
                fn();
                return name;
            } catch (e) {}
        }
        return null;
    }

    function jumpToPing(guildId, channel) {
        status.lastJump = `looking for the ping in #${channel.name}…`;
        return findPingMessageId(guildId, channel.id).then((found) => {
            if (!found) {
                status.lastJump = `no message found for #${channel.name} (${status.lastSearch || "no search"})`;
                toast(`Ping Box: couldn't find the ping in #${channel.name}`);
                return;
            }
            const via = navigate(guildId, channel.id, found.id);
            status.lastJump = via ? `#${channel.name}: ${found.how} -> ${via}` : `#${channel.name}: found (${found.how}) but no way to open it`;
            if (!via) toast("Ping Box: found the ping but couldn't open it");
        });
    }

    // ── the box ────────────────────────────────────────────────────────────
    function useStoreUpdates(names) {
        const [, force] = React.useReducer((x) => x + 1, 0);
        React.useEffect(() => {
            const subs = names.map(store).filter((s) => s && typeof s.addChangeListener === "function");
            subs.forEach((s) => s.addChangeListener(force));
            return () => subs.forEach((s) => safe(() => s.removeChangeListener(force)));
        }, []);
    }

    const Badge = ({ n }) =>
        h(
            View,
            { style: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: COLORS.red, alignItems: "center", justifyContent: "center" } },
            h(Text, { style: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" } }, n > 99 ? "99+" : String(n)),
        );

    function PingBox() {
        useStoreUpdates(["ReadStateStore", "SelectedGuildStore", "GuildChannelStore"]);
        status.boxRenders++;
        const guildId = safe(() => store("SelectedGuildStore").getGuildId(), null);
        const list = pingedChannels(guildId);
        if (!list.length || storage.enabled === false) return null;
        return h(
            View,
            {
                style: {
                    marginHorizontal: 8, marginTop: 6, marginBottom: 4, paddingVertical: 6, borderRadius: 14,
                    backgroundColor: COLORS.box, borderWidth: 1, borderColor: COLORS.border,
                },
            },
            h(Text, { style: { color: COLORS.sub, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, paddingHorizontal: 12, paddingBottom: 4 } }, "PINGS"),
            list.slice(0, 6).map((c) =>
                h(
                    Pressable,
                    {
                        key: c.id,
                        onPress: () => jumpToPing(guildId, c),
                        style: ({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 7, opacity: pressed ? 0.6 : 1 }),
                    },
                    h(Text, { style: { color: COLORS.muted, fontSize: 18, marginRight: 8 } }, "#"),
                    h(
                        View,
                        { style: { flex: 1 } },
                        h(Text, { numberOfLines: 1, style: { color: COLORS.text, fontSize: 15, fontWeight: "600" } }, c.name),
                        c.category ? h(Text, { numberOfLines: 1, style: { color: COLORS.muted, fontSize: 11 } }, c.category) : null,
                    ),
                    h(Badge, { n: c.count }),
                ),
            ),
            list.length > 6 ? h(Text, { style: { color: COLORS.muted, fontSize: 11, paddingHorizontal: 12, paddingTop: 2 } }, `+${list.length - 6} more`) : null,
        );
    }

    // ── hook the channel list (plain function -> applies on next redraw, e.g. switching servers) ──
    function hookChannelList() {
        if (status.hook === "ok") return true;
        const exp = exportsByPath(CHANNEL_LIST);
        if (!exp || typeof exp.default !== "function") {
            status.hook = "waiting: channel list not loaded yet";
            return false;
        }
        unpatches.push(
            patcher.after("default", exp, (args, res) => {
                if (!res) return res;
                // always the same shape (box may render nothing) so the list never remounts when pings change
                return h(View, { style: { flex: 1 } }, h(PingBox, { key: "ping-box" }), h(View, { key: "list", style: { flex: 1 } }, res));
            }),
        );
        status.hook = "ok";
        return true;
    }

    function Settings() {
        const [, force] = React.useReducer((x) => x + 1, 0);
        const line = (t) => h(Text, { style: { color: COLORS.sub, fontSize: 12, paddingHorizontal: 16, marginTop: 4 } }, t);
        return h(
            View,
            { style: { flex: 1, paddingTop: 12 } },
            h(
                Pressable,
                {
                    onPress: () => {
                        storage.enabled = storage.enabled === false;
                        force();
                    },
                    style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 },
                },
                h(
                    View,
                    { style: { flex: 1 } },
                    h(Text, { style: { color: COLORS.text, fontSize: 16, fontWeight: "600" } }, "Show ping box"),
                    h(Text, { style: { color: COLORS.sub, fontSize: 13, marginTop: 2 } }, "Pinged channels at the top of each server's channel list. Tap one to jump to the ping."),
                ),
                h(ReactNative.Switch, { value: storage.enabled !== false, onValueChange: () => { storage.enabled = storage.enabled === false; force(); } }),
            ),
            h(View, { style: { height: 12 } }),
            line(`Ping Box ${VERSION} diagnostics`),
            line(`channel list hook: ${status.hook} · box draws ${status.boxRenders} · channels from ${status.channelsSource}`),
            line(`last jump: ${status.lastJump}`),
        );
    }

    let timer = null;
    let stopped = false;
    return {
        onLoad() {
            stopped = false;
            let tries = 0;
            const loop = () => {
                if (stopped || safe(hookChannelList, false)) return;
                if (++tries < 120) timer = setTimeout(loop, 1000);
            };
            loop();
        },
        onUnload() {
            stopped = true;
            if (timer) clearTimeout(timer);
            unpatches.splice(0).forEach((u) => safe(u));
        },
        settings: Settings,
    };
})()
