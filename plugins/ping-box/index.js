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

    const VERSION = "1.3.0";
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

    const newerThan = (a, b) => !b || safe(() => BigInt(a) > BigInt(b), String(a) > String(b));
    const olderOf = (a, b) => (!a ? b : !b ? a : newerThan(a, b) ? b : a);

    // ── fast paths: pings we already know about, no network needed ─────────
    // a) pings recorded live as they arrive (exact ids)
    const livePings = {}; // channelId -> [message ids]
    function onMessageCreate(e) {
        safe(() => {
            const m = e && e.message;
            const channelId = (e && e.channelId) || (m && m.channel_id);
            const guildId = (e && e.guildId) || (m && m.guild_id);
            if (!m || !m.id || !channelId || !guildId || e.optimistic) return;
            const uid = me();
            if (!uid || (m.author && m.author.id === uid)) return;
            if (!pingsMe(m, uid, myRoleIds(guildId))) return;
            const list = livePings[channelId] || (livePings[channelId] = []);
            if (list.indexOf(m.id) === -1) list.push(m.id);
            if (list.length > 50) list.shift();
        });
    }
    // b) messages Discord already has loaded for the channel
    function cachedPing(guildId, channelId, ack) {
        const uid = me();
        const roles = myRoleIds(guildId);
        const live = (livePings[channelId] || []).filter((id) => newerThan(id, ack));
        let best = live.length ? live.reduce(olderOf) : null;
        const msgs = safe(() => {
            const cm = store("MessageStore").getMessages(channelId);
            return (cm && (cm._array || (cm.toArray && cm.toArray()))) || [];
        }, []);
        for (const m of msgs) {
            if (m && newerThan(m.id, ack) && (!m.author || m.author.id !== uid) && pingsMe(m, uid, roles)) best = olderOf(best, m.id);
        }
        // c) Discord's recent-mentions list (only ones you haven't read)
        safe(() => {
            const rm = store("RecentMentionsStore");
            const list = (rm.getMentions && rm.getMentions()) || [];
            for (const m of list) if ((m.channel_id || m.channelId) === channelId && newerThan(m.id, ack)) best = olderOf(best, m.id);
        });
        return best;
    }

    // ── results found ahead of time, so a tap opens the ping instantly ──────
    const found = {}; // channelId -> { ack, result }
    const inFlight = {}; // channelId -> Promise

    // returns a Promise of { id, how } (or a fallback) - never rejects
    function findPingMessageId(guildId, channelId) {
        const ack = lastReadId(channelId);
        const quick = cachedPing(guildId, channelId, ack);
        if (quick) return Promise.resolve({ id: quick, how: "already loaded" });
        const f = found[channelId];
        if (f && f.ack === ack && f.result) return Promise.resolve(f.result);
        if (inFlight[channelId]) return inFlight[channelId];

        const notes = [];
        const uid = me();
        const roles = myRoleIds(guildId);
        notes.push(ack ? "last read found" : "no last-read point");
        const quiet = (p, label) => p.catch((e) => {
            notes.push(`${label} error ${(e && (e.status || e.message)) || e}`);
            return { msgs: [] };
        });
        const base = { channel_id: channelId, sort_by: "timestamp", sort_order: "asc" };
        if (ack) base.min_id = ack;
        // all at once (one round trip instead of up to six one after another):
        //   the first unread page (catches role pings), your name pings, and @everyone/@here
        const asks = [
            quiet(search(guildId, base), "unread"),
            uid ? quiet(search(guildId, Object.assign({ mentions: uid }, base)), "name") : Promise.resolve({ msgs: [] }),
            quiet(search(guildId, Object.assign({ mention_everyone: true }, base)), "everyone"),
        ];
        const p = Promise.all(asks)
            .then(([unread, named, everyone]) => {
                let best = null;
                unread.msgs.forEach((m) => pingsMe(m, uid, roles) && (best = olderOf(best, m.id)));
                if (named.msgs[0]) best = olderOf(best, named.msgs[0].id);
                if (everyone.msgs[0]) best = olderOf(best, everyone.msgs[0].id);
                if (best) return { id: best, how: "oldest unread ping" };
                // role ping further down than the first page: keep paging the unread messages
                const page = (offset) => {
                    if (!ack || offset >= 100) return Promise.resolve(null);
                    return quiet(search(guildId, Object.assign({ offset }, base)), "unread").then(({ msgs }) => {
                        const hit = msgs.find((m) => pingsMe(m, uid, roles));
                        if (hit) return { id: hit.id, how: "oldest unread ping" };
                        return msgs.length < 25 ? null : page(offset + 25);
                    });
                };
                return unread.msgs.length < 25 ? null : page(25);
            })
            .then((r) => {
                if (r) return r;
                // nothing unread pings you: fall back to your newest ping, then where you stopped reading
                return quiet(search(guildId, { channel_id: channelId, mentions: uid }), "newest").then(({ msgs }) =>
                    msgs[0] ? { id: msgs[0].id, how: "newest name ping" } : ack ? { id: ack, how: "where you stopped reading" } : null);
            })
            .then((r) => {
                status.lastSearch = notes.join(", ");
                if (r) found[channelId] = { ack, result: r };
                delete inFlight[channelId];
                return r;
            }, () => {
                delete inFlight[channelId];
                return null;
            });
        inFlight[channelId] = p;
        return p;
    }

    // look up the top 3 pings in the background, spaced out (Discord limits how fast you can search)
    function prefetch(guildId, list) {
        list.slice(0, 3).forEach((c, i) => {
            const ack = lastReadId(c.id);
            const f = found[c.id];
            if (inFlight[c.id] || (f && f.ack === ack) || cachedPing(guildId, c.id, ack)) return;
            found[c.id] = { ack, result: null }; // mark as started for this read point
            setTimeout(() => safe(() => findPingMessageId(guildId, c.id)), 300 + i * 800);
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
        // 1) Discord's internal link handler - what the working "Jump To Top" plugin uses on mobile
        const viaOpenUrl = safe(() => {
            props("openUrl", "openUrl").openUrl(`https://discord.com${path}`);
            return true;
        }, false);
        if (viaOpenUrl) {
            [450, 1100, 2000].forEach((ms) =>
                setTimeout(() => safe(() => props("jump", "jumpToMessage").jumpToMessage({ channelId, messageId, flash: true, jumpType: "ANIMATED" })), ms),
            );
            return "openUrl";
        }
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
        const f = found[channel.id];
        if (!(f && f.result) && !cachedPing(guildId, channel.id, lastReadId(channel.id))) toast(`Ping Box: finding the ping in #${channel.name}…`);
        return findPingMessageId(guildId, channel.id).then((hit) => {
            if (!hit) {
                status.lastJump = `no message found for #${channel.name} (${status.lastSearch || "no search"}) -> opened channel`;
                const ok = safe(() => {
                    props("openUrl", "openUrl").openUrl(`https://discord.com/channels/${guildId}/${channel.id}`);
                    return true;
                }, false) || safe(() => {
                    Linking.openURL(`discord://-/channels/${guildId}/${channel.id}`);
                    return true;
                }, false) || safe(() => {
                    props("trans", "transitionTo").transitionTo(`/channels/${guildId}/${channel.id}`);
                    return true;
                }, false);
                toast(`Ping Box: couldn't find the exact ping in #${channel.name}${ok ? ", opened the channel" : ""} (${status.lastSearch || "no search"})`);
                return;
            }
            const via = navigate(guildId, channel.id, hit.id);
            status.lastJump = via ? `#${channel.name}: ${hit.how} -> ${via}` : `#${channel.name}: found (${hit.how}) but no way to open it`;
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
        safe(() => prefetch(guildId, list));
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
            safe(() => metro.common.FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate));
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
            safe(() => metro.common.FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate));
            if (timer) clearTimeout(timer);
            unpatches.splice(0).forEach((u) => safe(u));
        },
        settings: Settings,
    };
})()
