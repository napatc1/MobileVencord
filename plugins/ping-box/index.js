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

    const VERSION = "1.1.2";
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

    // ── searching (plain promises: no async/await for Hermes runtime eval) ──
    const getHTTP = () => safe(() => props("http", "HTTP").HTTP, null) || props("http2", "get", "post", "patch", "del");
    function search(guildId, query) {
        const HTTP = getHTTP();
        if (!HTTP || typeof HTTP.get !== "function") return Promise.reject(new Error("no HTTP"));
        const run = () => Promise.resolve(HTTP.get({ url: `/guilds/${guildId}/messages/search`, query }));
        return run().then((res) => {
            // Discord answers 202 while it's still indexing a channel: wait a moment and try once more
            if (res && res.status === 202) return new Promise((r) => setTimeout(r, 1500)).then(run);
            return res;
        }).then((res) => {
            const body = (res && res.body) || {};
            const msgs = (body.messages || []).map((arr) => (Array.isArray(arr) ? arr.find((x) => x && x.hit) || arr[0] : arr)).filter(Boolean);
            return { msgs, total: body.total_results };
        });
    }

    // the point where you stopped reading in a channel (several store method names across versions)
    function lastReadId(channelId) {
        const rs = store("ReadStateStore");
        for (const fn of ["ackMessageId", "getAckMessageId", "lastAckedMessageId"]) {
            const v = safe(() => rs[fn](channelId), null);
            if (v) return v;
        }
        return safe(() => rs.getOldestUnreadMessageId(channelId), null);
    }

    function myRoleIds(guildId) {
        const uid = me();
        const member = safe(() => store("GuildMemberStore").getMember(guildId, uid), null);
        return (member && member.roles) || [];
    }

    // does this message ping me: by name, @everyone/@here, or a role I have
    const pingsMe = (m, uid, roles) =>
        !!m && (m.mention_everyone ||
            (m.mentions || []).some((u) => (u && (u.id || u)) === uid) ||
            (m.mention_roles || []).some((r) => roles.indexOf(r) !== -1));

    // returns a Promise of { id, how } (or a fallback) - never rejects
    function findPingMessageId(guildId, channelId) {
        const notes = [];
        // a) mentions Discord already has in memory
        const recent = safe(() => {
            const rm = store("RecentMentionsStore");
            const list = (rm.getMentions && rm.getMentions()) || [];
            const hit = list.find((m) => (m.channel_id || m.channelId) === channelId);
            return hit && hit.id;
        }, null);
        if (recent) return Promise.resolve({ id: recent, how: "recent mentions" });

        const uid = me();
        const roles = myRoleIds(guildId);
        const ack = lastReadId(channelId);
        notes.push(ack ? "last read found" : "no last-read point");

        // b) oldest unread message that pings me (by name, @everyone or one of my roles)
        const scanUnread = (offset) => {
            if (!ack || offset >= 100) return Promise.resolve(null);
            return search(guildId, { channel_id: channelId, min_id: ack, sort_by: "timestamp", sort_order: "asc", offset })
                .then(({ msgs }) => {
                    const hit = msgs.find((m) => pingsMe(m, uid, roles));
                    if (hit) return { id: hit.id, how: "oldest unread ping" };
                    if (msgs.length < 25) return null; // no more pages
                    return scanUnread(offset + 25);
                });
        };
        const newest = (query, how) =>
            search(guildId, Object.assign({ channel_id: channelId }, query)).then(({ msgs, total }) => {
                notes.push(`${how}: ${total != null ? total : msgs.length}`);
                return msgs[0] ? { id: msgs[0].id, how } : null;
            });
        const orNext = (p, next) => p.catch((e) => {
            notes.push(`search error ${(e && (e.status || e.message)) || e}`);
            return null;
        }).then((r) => r || next());

        return orNext(scanUnread(0), () =>
            orNext(uid ? newest({ mentions: uid }, "newest name ping") : Promise.resolve(null), () =>
                orNext(newest({ mention_everyone: true }, "newest @everyone"), () =>
                    Promise.resolve(ack ? { id: ack, how: "where you stopped reading" } : null))))
            .then((r) => {
                status.lastSearch = notes.join(", ");
                return r;
            });
    }

    // Open the chat AT the message. jumpToMessage only scrolls a chat that is already open (from the
    // channel list it silently does nothing), so first open the chat with Discord's own message link,
    // then jumpToMessage once it's open to scroll + highlight.
    function navigate(guildId, channelId, messageId) {
        const path = `/channels/${guildId}/${channelId}/${messageId}`;
        // Discord's own deep link first: it is what the app itself uses for message links on phones.
        // transitionTo is only a fallback if the link is refused (it may exist but do nothing on mobile).
        const viaRouter = () =>
            safe(() => {
                props("trans", "transitionTo").transitionTo(path);
                return true;
            }, false);
        const opened =
            (safe(() => {
                const pr = Linking.openURL(`discord://-${path}`);
                if (pr && typeof pr.catch === "function")
                    pr.catch(() => {
                        status.lastJump += " (link refused, used router)";
                        viaRouter();
                    });
                return true;
            }, false) && "message link") ||
            (viaRouter() && "transitionTo");
        // scroll + highlight once the chat is on screen (harmless if it already is)
        [700, 1600].forEach((ms) =>
            setTimeout(() => safe(() => props("jump", "jumpToMessage").jumpToMessage({ channelId, messageId, flash: true })), ms),
        );
        return opened || (props("jump", "jumpToMessage") ? "jumpToMessage only" : null);
    }

    function jumpToPing(guildId, channel) {
        status.lastJump = `looking for the ping in #${channel.name}…`;
        toast(`Ping Box: finding the ping in #${channel.name}…`);
        return findPingMessageId(guildId, channel.id).then((found) => {
            if (!found) {
                status.lastJump = `no message found for #${channel.name} (${status.lastSearch || "no search"}) -> opened channel`;
                const ok = safe(() => {
                    Linking.openURL(`discord://-/channels/${guildId}/${channel.id}`);
                    return true;
                }, false) || safe(() => {
                    props("trans", "transitionTo").transitionTo(`/channels/${guildId}/${channel.id}`);
                    return true;
                }, false);
                toast(`Ping Box: couldn't find the exact ping in #${channel.name}${ok ? ", opened the channel" : ""} (${status.lastSearch || "no search"})`);
                return;
            }
            const via = navigate(guildId, channel.id, found.id);
            if (via) toast(`Ping Box: opening the ping in #${channel.name}`);
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
            line(`last search: ${status.lastSearch || "none"}`),
        );
    }

    let timer = null;
    let stopped = false;
    // ── self-repair after a partial update ─────────────────────────────────
    // Render's CDN can briefly serve a new manifest with old code; Kettu then stores the old code under
    // the new hash and a normal Refetch never downloads it again. If our code's VERSION doesn't match
    // the manifest's "version", force Kettu to re-download the code and restart us (max 3 tries).
    function selfRepair(NAME) {
        const want = safe(() => vendetta.plugin.manifest.version, null);
        if (!want || want === VERSION) {
            storage.__repairTries = 0;
            return;
        }
        const tries = (storage.__repairTries || 0) + 1;
        storage.__repairTries = tries;
        if (tries > 3) {
            toast(`${NAME}: couldn't finish updating to ${want}. Remove it and install it again from the same link.`);
            return;
        }
        toast(`${NAME}: finishing update to ${want}…`);
        setTimeout(() => {
            const P = safe(() => vendetta.plugins, null);
            const id = safe(() => vendetta.plugin.id, null);
            if (!P || !id) return;
            safe(() => {
                P.plugins[id].manifest.hash = "repair-" + Date.now();
            });
            Promise.resolve(safe(() => P.fetchPlugin(id), null))
                .then(() => {
                    const js = safe(() => P.plugins[id].js, "") || "";
                    if (js.indexOf(`const VERSION = "${want}"`) === -1) {
                        toast(`${NAME}: the update isn't ready yet, will try again next time Discord starts`);
                        return;
                    }
                    P.stopPlugin(id, false);
                    P.startPlugin(id);
                })
                .catch(() => {});
        }, 8000);
    }

    return {
        onLoad() {
            safe(() => selfRepair("Ping Box"));
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
