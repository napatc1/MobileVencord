(() => {
    "use strict";
    // Midnight Layout - step 1: layout scanner.
    // Watches which screen components Discord actually draws on this device, so the next
    // version can give the right ones midnight's rounded, floating-panel look.
    // Hooks only count renders and describe the root element; they never change output.

    const { metro, patcher, plugin } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative } = metro.common;
    const { View, Text, ScrollView, Pressable, StyleSheet, ImageBackground, TextInput } = ReactNative;
    const h = React.createElement;

    const VERSION = "0.6.0";
    // every module that can draw part of the main screens (server bar, channel list, DMs, chat, tabs)
    const RX = /(main_tabs_v2\/native|channel_list_v2\/native|guilds_bar\/native|guild_sidebar\/native|home\/native|home_drawer\/native|chat\/native|chat_input\/native|you_tab|user_profile\/native\/UserPanel|notifications\/native|private_channels)/i;

    const safe = (fn, fb) => {
        try {
            const r = fn();
            return r === undefined ? fb : r;
        } catch (e) {
            return fb;
        }
    };
    const toast = (m) => safe(() => vendetta.ui.toasts.showToast(m));

    const hooked = new Map(); // key -> record
    const unpatches = [];
    let stopped = false;

    function describeRoot(res) {
        return safe(() => {
            let n = res;
            for (let i = 0; i < 3 && n && n.props && !n.props.style && n.props.children && !Array.isArray(n.props.children); i++) n = n.props.children;
            if (!n || !n.props) return String(n);
            const t = n.type;
            const name = typeof t === "string" ? t : t && (t.displayName || t.name || (t.render && t.render.name) || (t.$$typeof ? "memo/fwd" : typeof t));
            const st = safe(() => StyleSheet.flatten(n.props.style), {}) || {};
            const keep = ["flex", "backgroundColor", "borderRadius", "margin", "marginTop", "padding", "paddingTop", "width", "height", "position"];
            const style = keep.filter((k) => st[k] !== undefined).map((k) => `${k}:${st[k]}`).join(" ");
            return `${name || "?"}${style ? " {" + style + "}" : ""}`;
        }, "?");
    }

    function hookExport(path, id, exp, key) {
        const comp = safe(() => exp[key]);
        if (!comp) return;
        const rec = { path, key, renders: 0, root: "", via: "" };
        const cb = (args, res) => {
            rec.renders++;
            if (!rec.root || rec.renders % 20 === 0) rec.root = describeRoot(res);
            return res;
        };
        let un = null;
        safe(() => {
            if (typeof comp === "function" && !(comp.prototype && comp.prototype.isReactComponent)) {
                un = patcher.after(key, exp, cb);
                rec.via = "fn";
            } else if (comp && comp.prototype && comp.prototype.render) {
                un = patcher.after("render", comp.prototype, cb);
                rec.via = "class";
            } else if (comp && typeof comp.render === "function") {
                un = patcher.after("render", comp, cb);
                rec.via = "fwd";
            } else if (comp && comp.type && typeof comp.type.render === "function") {
                un = patcher.after("render", comp.type, cb);
                rec.via = "memo(fwd)";
            } else if (comp && typeof comp.type === "function") {
                un = patcher.after("type", comp, cb);
                rec.via = "memo";
            }
        });
        if (un) {
            unpatches.push(un);
            hooked.set(`${id}:${key}`, rec);
        }
    }

    function sweep() {
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        let added = 0;
        for (const id in mods) {
            if (hooked.size > 500) break;
            const m = mods[id];
            const path = m && m.__filePath;
            if (!path || !RX.test(path) || !/\.tsx$/.test(path)) continue;
            const exp = safe(() => m.publicModule.exports);
            if (!exp || typeof exp !== "object") continue;
            for (const key of safe(() => Object.keys(exp), []).slice(0, 12)) {
                if (hooked.has(`${id}:${key}`)) continue;
                const v = safe(() => exp[key]);
                const isComp = typeof v === "function" || (v && typeof v === "object" && v.$$typeof);
                if (!isComp) continue;
                // only components: "default" or Capitalised names (skips hooks, getters, render helpers, navigation utils)
                if (key !== "default" && !/^[A-Z]/.test(key)) continue;
                hookExport(path, id, exp, key);
                added++;
            }
        }
        return added;
    }

    function report() {
        const rows = [...hooked.values()].sort((a, b) => b.renders - a.renders);
        const lines = rows.map((r) => `${r.renders}× ${r.path} :: ${r.key} [${r.via}] ${r.renders ? "→ " + r.root : ""}`);
        const dims = safe(() => {
            const d = ReactNative.Dimensions.get("window");
            return `${Math.round(d.width)}x${Math.round(d.height)}`;
        }, "?");
        return `Midnight Layout ${VERSION} report · screen ${dims} · ${rows.length} hooked, ${rows.filter((r) => r.renders).length} drawn\n` + lookReport() + "\n--- drawn parts:\n" + lines.filter((l) => !l.startsWith("0×")).slice(0, 150).join("\n");
    }

    function Row({ label, value, onChange }) {
        return h(
            Pressable,
            { onPress: () => onChange(!value), style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 } },
            h(Text, { style: { flex: 1, color: "#E6EAF5", fontSize: 16, fontWeight: "600" } }, label),
            h(ReactNative.Switch, { value, onValueChange: onChange }),
        );
    }

    function Settings() {
        const [out, setOut] = React.useState(null);
        const [, force] = React.useReducer((x) => x + 1, 0);
        const btn = (label, onPress) =>
            h(
                Pressable,
                { onPress, style: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 12, backgroundColor: "#3673CB", alignItems: "center" } },
                h(Text, { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" } }, label),
            );
        return h(
            ScrollView,
            { style: { flex: 1 } },
            h(
                Text,
                { style: { color: "#8592AD", fontSize: 14, padding: 16, lineHeight: 20 } },
                "Midnight look: rounded chat, message box, channel list and DMs list. The channel list updates when you switch servers; the DMs list after Discord restarts. Each part has a switch below if anything looks wrong.",
            ),
            h(Row, { label: "Glass style (like Glassify)", value: isGlass(), onChange: (v) => { storage.style = v ? "glass" : "midnight"; force(); } }),
            isGlass()
                ? h(
                      View,
                      { style: { paddingHorizontal: 16, paddingBottom: 8 } },
                      h(Text, { style: { color: "#8592AD", fontSize: 13, marginBottom: 6 } }, "Wallpaper link (leave empty for the default aurora):"),
                      TextInput
                          ? h(TextInput, {
                                defaultValue: typeof storage.glassImage === "string" ? storage.glassImage : "",
                                placeholder: GLASS_DEFAULT_IMAGE,
                                placeholderTextColor: "#576175",
                                autoCapitalize: "none",
                                autoCorrect: false,
                                onChangeText: (t) => { storage.glassImage = t.trim(); },
                                style: { color: "#E3E8F4", fontSize: 13, padding: 10, borderRadius: 10, backgroundColor: "#1C1F26", borderWidth: 1, borderColor: "#2B303B" },
                            })
                          : null,
                      h(Text, { style: { color: "#8592AD", fontSize: 13, marginTop: 12 } }, `Panel darkness: ${glassAlpha()}%   ·   Wallpaper blur: ${glassBlur()}`),
                      h(View, { style: { flexDirection: "row", marginTop: 6 } },
                          [["Darker", () => { storage.glassAlpha = Math.min(90, glassAlpha() + 10); force(); }],
                           ["Clearer", () => { storage.glassAlpha = Math.max(10, glassAlpha() - 10); force(); }],
                           ["More blur", () => { storage.glassBlur = Math.min(40, glassBlur() + 10); force(); }],
                           ["Less blur", () => { storage.glassBlur = Math.max(0, glassBlur() - 10); force(); }]].map(([t, f]) =>
                              h(Pressable, { key: t, onPress: f, style: { paddingHorizontal: 10, paddingVertical: 8, marginRight: 6, borderRadius: 8, backgroundColor: "#2B303B" } },
                                  h(Text, { style: { color: "#E3E8F4", fontSize: 12 } }, t)))),
                      h(Text, { style: { color: "#576175", fontSize: 12, marginTop: 8 } }, "For the full look, also use the Midnight Glass theme. Changes show when each screen redraws."),
                  )
                : null,
            h(Row, { label: "Rounded chat panel", value: on("roundChat"), onChange: (v) => { storage.roundChat = v; force(); } }),
            h(Row, { label: "Rounded message box", value: on("roundInput"), onChange: (v) => { storage.roundInput = v; force(); } }),
            h(Row, { label: "Rounded channel list", value: on("roundChannels"), onChange: (v) => { storage.roundChannels = v; force(); } }),
            h(Row, { label: "Rounded DMs list", value: on("roundDMs"), onChange: (v) => { storage.roundDMs = v; force(); } }),
            h(Text, { style: { color: "#576175", fontSize: 12, paddingHorizontal: 16 } }, "Changes show the next time each screen redraws (open another channel)."),
            btn("Copy report", () => {
                sweep();
                const r = report();
                setOut(r);
                const ok = safe(() => {
                    metro.common.clipboard.setString(r);
                    return true;
                }, false);
                toast(ok ? "Report copied - paste it to Claude" : "Screenshot the report below");
            }),
            btn("Rescan", () => {
                const n = sweep();
                toast(`Midnight Layout: ${n} new parts hooked (${hooked.size} total)`);
                force();
            }),
            h(Text, { style: { color: "#8592AD", fontSize: 12, padding: 16 } }, `${hooked.size} parts hooked`),
            out ? h(Text, { selectable: true, style: { color: "#8592AD", fontSize: 11, paddingHorizontal: 16, paddingBottom: 40, fontFamily: "Menlo" } }, out) : null,
        );
    }

    // ── step 2: midnight look ─────────────────────────────────────────────
    // Stronger than desktop midnight on purpose: on a phone only one panel shows at a time, so the
    // desktop's 20%-alpha border and 8pt gaps read as a plain recolour. Same palette, visible structure.
    const MID = { frame: "#1C1F26", panel: "#16181D", raised: "#2B303B", border: "#2B303B", gap: 10, radius: 20 };
    const LOOK = {
        chat: "modules/chat/native/ChatViewWrapper.tsx",
        input: "modules/chat_input/native/ChatInput.tsx",
        layout: "modules/main_tabs_v2/native/shared_components/guild_channels/layouts/ChannelListLayout.tsx",
        channels: "modules/channel_list_v2/native/RedesignChannelList.tsx",
        channelsWidth: "modules/channel_list_v2/native/useChannelListWidth.tsx",
        dms: "modules/main_tabs_v2/native/tabs/messages/Messages.tsx",
    };
    const lookStatus = { chat: "not started", input: "not started", layout: "not started", channels: "not started", channelsWidth: "not started", dms: "not started" };
    // channel list panel spacing; its content width is reduced by exactly this much so nothing is cut off
    const CH = { left: 4, right: MID.gap, top: 4, bottom: MID.gap };
    const CH_WIDTH_CUT = CH.left + CH.right + 2; // + 1px border each side
    const lookDiag = { layoutStyles: "", inputRoot: "" };
    const lookUnpatches = [];
    const on = (k) => storage[k] !== false;

    function exportsByPath(path) {
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        for (const id in mods) {
            const m = mods[id];
            if (m && m.__filePath === path) return safe(() => m.publicModule.exports, null);
        }
        return null;
    }

    // rounded floating panel: frame-coloured padding around a rounded, bordered, clipped box
    // ── Glass style (Glassify-like): blurred wallpaper behind see-through panels ──
    const GLASS_DEFAULT_IMAGE = "https://mobilevencord.onrender.com/images/glass-aurora.jpg";
    const isGlass = () => storage.style === "glass";
    const glassImage = () => (typeof storage.glassImage === "string" && /^https?:\/\//.test(storage.glassImage) ? storage.glassImage : GLASS_DEFAULT_IMAGE);
    const glassBlur = () => (typeof storage.glassBlur === "number" ? storage.glassBlur : 0);
    const glassAlpha = () => (typeof storage.glassAlpha === "number" ? storage.glassAlpha : 55); // % panel darkness
    const alphaHex = (pct) => Math.round(Math.max(0, Math.min(100, pct)) * 2.55).toString(16).padStart(2, "0").toUpperCase();
    const GLASS = {
        panel: () => "#0E0F16" + alphaHex(glassAlpha()),
        box: () => "#0E0F16" + alphaHex(Math.min(100, glassAlpha() + 15)),
        border: "#FFFFFF24",
    };

    const panel = (child, extra) => {
        const glass = isGlass();
        const outerStyle = [{ flex: 1, backgroundColor: glass ? "#0B0C12" : MID.frame, paddingHorizontal: MID.gap, paddingBottom: MID.gap, paddingTop: 2 }, extra && extra.outer];
        const inner = h(
            View,
            {
                style: [{
                    flex: 1, borderRadius: MID.radius, overflow: "hidden",
                    backgroundColor: glass ? GLASS.panel() : MID.panel,
                    borderWidth: 1, borderColor: glass ? GLASS.border : MID.border,
                }, extra && extra.inner],
            },
            child,
        );
        if (glass && ImageBackground)
            return h(ImageBackground, { source: { uri: glassImage() }, blurRadius: glassBlur(), resizeMode: "cover", style: outerStyle }, inner);
        return h(View, { style: outerStyle }, inner);
    };

    function hookChat() {
        if (lookStatus.chat.startsWith("ok")) return true;
        const exp = exportsByPath(LOOK.chat);
        if (!exp || typeof exp.default !== "function") return (lookStatus.chat = "waiting: chat not loaded yet"), false;
        lookUnpatches.push(
            patcher.after("default", exp, (args, res) => {
                lookStatus.chatRenders = (lookStatus.chatRenders || 0) + 1;
                if (!on("roundChat") || !res) return res;
                return panel(res);
            }),
        );
        lookStatus.chat = "ok";
        return true;
    }

    function hookInput() {
        if (lookStatus.input.startsWith("ok")) return true;
        const exp = exportsByPath(LOOK.input);
        const comp = exp && exp.default;
        if (!comp) return (lookStatus.input = "waiting: chat box not loaded yet"), false;
        const cb = (args, res) => {
            lookStatus.inputRenders = (lookStatus.inputRenders || 0) + 1;
            safe(() => {
                if (!lookDiag.inputRoot) lookDiag.inputRoot = describeRoot(res);
            });
            if (!on("roundInput") || !res || !res.props) return res;
            // copy instead of editing Discord's element in place (props can be read-only)
            return safe(() => React.cloneElement(res, {
                style: [res.props.style, {
                    // no overflow:hidden here - the chat box can contain reply bars and suggestion pop-ups
                    marginHorizontal: MID.gap, marginBottom: 4, borderRadius: MID.radius,
                    backgroundColor: isGlass() ? GLASS.box() : MID.frame, borderWidth: 1, borderColor: isGlass() ? GLASS.border : MID.border,
                }],
            }), res);
        };
        let un = null;
        if (comp.type && typeof comp.type.render === "function") un = patcher.after("render", comp.type, cb);
        else if (typeof comp.render === "function") un = patcher.after("render", comp, cb);
        else if (typeof comp.type === "function") un = patcher.after("type", comp, cb);
        if (!un) return (lookStatus.input = "failed: unknown component shape"), false;
        lookUnpatches.push(un);
        lookStatus.input = "ok";
        return true;
    }

    // record what the channel-list layout styles look like (for the next step)
    function hookLayout() {
        if (lookStatus.layout.startsWith("ok")) return true;
        const exp = exportsByPath(LOOK.layout);
        if (!exp || typeof exp.getLayoutStyles !== "function") return (lookStatus.layout = "waiting: channel list not loaded yet"), false;
        lookUnpatches.push(
            patcher.after("getLayoutStyles", exp, (args, res) => {
                safe(() => {
                    if (lookDiag.layoutStyles) return;
                    const argInfo = safe(() => JSON.stringify(args, (k, v) => (typeof v === "function" ? "fn" : v)).slice(0, 300), "?");
                    const parts = Object.keys(res || {}).map((k) => {
                        const st = safe(() => StyleSheet.flatten(res[k]), {}) || {};
                        return `  ${k}: ${safe(() => JSON.stringify(st), "?").slice(0, 220)}`;
                    });
                    lookDiag.layoutStyles = `args ${argInfo}\n${parts.join("\n")}`;
                });
                return res;
            }),
        );
        lookStatus.layout = "ok (recording)";
        return true;
    }

    // channel list: rounded panel beside the server bar (plain function -> applies on next redraw)
    function hookChannels() {
        if (lookStatus.channels.startsWith("ok")) return true;
        const exp = exportsByPath(LOOK.channels);
        if (!exp || typeof exp.default !== "function") return (lookStatus.channels = "waiting: channel list not loaded yet"), false;
        lookUnpatches.push(
            patcher.after("default", exp, (args, res) => {
                lookStatus.channelsRenders = (lookStatus.channelsRenders || 0) + 1;
                if (!on("roundChannels") || !res) return res;
                return panel(res, { outer: { paddingLeft: CH.left, paddingRight: CH.right, paddingTop: CH.top, paddingBottom: CH.bottom } });
            }),
        );
        lookStatus.channels = "ok";
        return true;
    }

    // keep the channel list's own width calculation in step with the panel gaps
    function hookChannelsWidth() {
        if (lookStatus.channelsWidth.startsWith("ok")) return true;
        const exp = exportsByPath(LOOK.channelsWidth);
        if (!exp || typeof exp.default !== "function") return (lookStatus.channelsWidth = "waiting"), false;
        lookUnpatches.push(
            patcher.after("default", exp, (args, res) => {
                if (!on("roundChannels") || typeof res !== "number" || res <= CH_WIDTH_CUT * 4) return res;
                lookStatus.lastChannelsWidth = `${res} -> ${res - CH_WIDTH_CUT}`;
                return res - CH_WIDTH_CUT;
            }),
        );
        lookStatus.channelsWidth = "ok";
        return true;
    }

    // DMs list: rounded panel (memo component -> applies when the tab is next built, e.g. after an app restart)
    function hookDMs() {
        if (lookStatus.dms.startsWith("ok")) return true;
        const exp = exportsByPath(LOOK.dms);
        const comp = exp && exp.default;
        if (!comp) return (lookStatus.dms = "waiting: DMs not loaded yet"), false;
        const cb = (args, res) => {
            lookStatus.dmsRenders = (lookStatus.dmsRenders || 0) + 1;
            if (!on("roundDMs") || !res) return res;
            // glass: the DMs list paints its own solid background (#16181D, seen in your report); clear it
            const content = isGlass() && res.props ? safe(() => React.cloneElement(res, { style: [res.props.style, { backgroundColor: "transparent" }] }), res) : res;
            return panel(content, { outer: { paddingTop: 0 } });
        };
        let un = null;
        if (comp.type && typeof comp.type.render === "function") un = patcher.after("render", comp.type, cb);
        else if (typeof comp.render === "function") un = patcher.after("render", comp, cb);
        else if (typeof comp.type === "function") un = patcher.after("type", comp, cb);
        if (!un) return (lookStatus.dms = "failed: unknown component shape"), false;
        lookUnpatches.push(un);
        lookStatus.dms = "ok";
        return true;
    }

    function hookChatBackground() {
        if (lookStatus.chatBg === "ok") return true;
        const exp = exportsByPath("modules/chat/native/Chat.ios.tsx");
        const comp = exp && exp.default;
        if (!comp || typeof comp.render !== "function") return (lookStatus.chatBg = "waiting"), false;
        lookUnpatches.push(
            patcher.after("render", comp, (args, res) => {
                if (!isGlass() || !on("roundChat") || !res || !res.props) return res;
                return safe(() => React.cloneElement(res, { style: [res.props.style, { backgroundColor: "transparent" }] }), res);
            }),
        );
        lookStatus.chatBg = "ok";
        return true;
    }

    function applyLook() {
        safe(hookChatBackground);
        safe(hookChat);
        safe(hookInput);
        safe(hookLayout);
        safe(hookChannels);
        safe(hookChannelsWidth);
        safe(hookDMs);
    }

    function lookReport() {
        return [
            `--- look: chat ${lookStatus.chat} (${lookStatus.chatRenders || 0} draws) · chat box ${lookStatus.input} (${lookStatus.inputRenders || 0} draws) · layout ${lookStatus.layout}`,
            `--- channel list ${lookStatus.channels} (${lookStatus.channelsRenders || 0} draws) · width ${lookStatus.channelsWidth} ${lookStatus.lastChannelsWidth || ""} · DMs ${lookStatus.dms} (${lookStatus.dmsRenders || 0} draws)`,
            `--- chat box root: ${lookDiag.inputRoot}`,
            `--- channel list layout styles:\n${lookDiag.layoutStyles || "(not drawn yet - open a server's channel list)"}`,
        ].join("\n");
    }

    let timer = null;
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
            safe(() => selfRepair("Midnight Layout"));
            stopped = false;
            let tries = 0;
            const loop = () => {
                if (stopped) return;
                safe(sweep);
                safe(applyLook);
                if (++tries < 40) timer = setTimeout(loop, 3000); // keep catching screens as they load (2 min)
            };
            loop();
            if (storage.announcedVersion !== VERSION) {
                storage.announcedVersion = VERSION;
                toast(`Midnight Layout updated to ${VERSION}: switch servers to see the rounded channel list`);
            }
        },
        onUnload() {
            stopped = true;
            if (timer) clearTimeout(timer);
            unpatches.splice(0).forEach((u) => safe(u));
            lookUnpatches.splice(0).forEach((u) => safe(u));
            hooked.clear();
        },
        settings: Settings,
    };
})()
