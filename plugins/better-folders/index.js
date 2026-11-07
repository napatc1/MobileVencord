(() => {
    "use strict";
    // BetterFolders, rebuilt for Kettu. Original idea and code by fres (fres621/vendetta-plugins).
    // Folder column inspired by Vencord's BetterFolders.
    // Every lookup is guarded so a missing Discord internal disables one feature
    // instead of crashing the whole plugin.

    const { metro, patcher, plugin, logger } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative, FluxDispatcher } = metro.common;
    const { View, Text, Image, ScrollView, Switch, Pressable, Modal, Linking } = ReactNative;

    const VERSION = "1.9.1";
    const status = { autoCollapse: "not started", hideIcons: "not started", column: "not started", nav: "unused" };
    const stats = { renders: 0, previewPatched: 0, hostAttached: 0, hostMounted: false, attachMode: "none" };
    const unpatches = [];

    const COLORS = {
        // midnight (theme 3.1): frame #1C1F26, panel #16181D, raised #2B303B
        panel: "#1C1F26", border: "#53607A33", text: "#E3E8F4", sub: "#8592AD",
        selected: "#3673CB", tile: "#2B303B",
    };

    const safe = (fn, fallback) => {
        try {
            const r = fn();
            return r === undefined ? fallback : r;
        } catch (e) {
            return fallback;
        }
    };

    const asset = (name) => safe(() => vendetta.ui.assets.getAssetIDByName(name));
    const toast = (msg) => safe(() => vendetta.ui.toasts.showToast(msg, asset("img_guild_folder")));
    const h = React.createElement;

    // ── store lookups (with fallbacks for renamed stores) ─────────────────
    const ExpandedStore = safe(() => metro.findByStoreName("ExpandedGuildFolderStore"));
    const GuildStore = safe(() => metro.findByStoreName("GuildStore"));
    const SelectedGuildStore = safe(() => metro.findByStoreName("SelectedGuildStore"));
    const folderSources = [
        () => metro.findByStoreName("SortedGuildStore"),
        () => metro.findByStoreName("UserSettingsProtoStore"),
        () => metro.findByStoreName("GuildFolderStore"),
    ];

    function getFolders() {
        for (const src of folderSources) {
            const store = safe(src);
            const list = safe(() => store.getGuildFolders());
            if (Array.isArray(list)) return list;
        }
        return null;
    }

    const getFolder = (id) => safe(() => (getFolders() || []).find((f) => f.folderId === id), null);
    const isExpanded = (id) => !!safe(() => ExpandedStore.isFolderExpanded(id), false);
    let internalToggle = false;
    const toggle = (folderId) => {
        internalToggle = true;
        try {
            FluxDispatcher.dispatch({ type: "TOGGLE_GUILD_FOLDER_EXPAND", folderId });
        } finally {
            internalToggle = false;
        }
    };

    // Re-render collapsed folders by toggling them twice.
    function refreshFolders() {
        safe(() =>
            (getFolders() || [])
                .filter((f) => f.folderId && !isExpanded(f.folderId))
                .forEach(({ folderId }) => {
                    toggle(folderId);
                    toggle(folderId);
                }),
        );
    }

    // ── navigation to a guild (several fallbacks) ─────────────────────────
    function openGuild(guildId) {
        const tries = [
            ["transitionToGuild", () => metro.findByProps("transitionToGuild").transitionToGuild(guildId)],
            ["transitionToGuildSync", () => metro.findByProps("transitionToGuildSync").transitionToGuildSync(guildId)],
            ["transitionTo", () => metro.findByProps("transitionTo", "replaceWith").transitionTo(`/channels/${guildId}`)],
            ["deep link", () => Linking.openURL(`discord://-/channels/${guildId}`)],
        ];
        for (const [name, fn] of tries) {
            try {
                fn();
                status.nav = name;
                return true;
            } catch (e) {}
        }
        status.nav = "failed: no navigation method found";
        toast("BetterFolders: couldn't open that server");
        return false;
    }

    // ── tiny event emitter for the column state ───────────────────────────
    const listeners = new Set();
    let openFolderId = null;
    const setOpenFolder = (id) => {
        openFolderId = id;
        listeners.forEach((l) => safe(l));
    };
    const useOpenFolder = () => {
        const [, force] = React.useReducer((x) => x + 1, 0);
        React.useEffect(() => {
            listeners.add(force);
            return () => listeners.delete(force);
        }, []);
        return openFolderId;
    };

    // ── feature 1: tap handling (auto collapse / folder column) ───────────
    let warnedNoHost = false;
    function startFolderEvents() {
        if (!ExpandedStore) return (status.autoCollapse = status.column = "failed: ExpandedGuildFolderStore not found");
        if (!getFolders()) return (status.autoCollapse = status.column = "failed: folder list not found");

        const onToggle = ({ folderId: thisId }) => {
            if (internalToggle) return;
            // wait a tick so the store has applied this toggle
            setTimeout(() => {
                safe(() => {
                    if (storage.column && (stats.hostMounted || stats.alertMode !== "failed")) {
                        // keep the folder closed in the main list, show its servers in the column instead
                        if (isExpanded(thisId)) toggle(thisId);
                        if (stats.hostMounted) setOpenFolder(openFolderId === thisId ? null : thisId);
                        else if (!openFolderView(thisId) && isExpanded(thisId) === false) toggle(thisId); // open normally if it failed
                        return;
                    }
                    if (storage.column && !warnedNoHost) {
                        warnedNoHost = true;
                        toast(`BetterFolders: column not ready, opening normally (gc ${status.hideIcons.startsWith("hooked") ? "found" : "missing"}, renders ${stats.renders}, attached ${stats.hostAttached})`);
                    }
                    if (!storage.autoCollapse || !isExpanded(thisId)) return;
                    (getFolders() || [])
                        .filter((f) => f.folderId && f.folderId !== thisId && isExpanded(f.folderId))
                        .forEach(({ folderId }) => toggle(folderId));
                });
            }, 0);
        };
        FluxDispatcher.subscribe("TOGGLE_GUILD_FOLDER_EXPAND", onToggle);
        unpatches.push(() => FluxDispatcher.unsubscribe("TOGGLE_GUILD_FOLDER_EXPAND", onToggle));
        status.autoCollapse = "ok";
    }

    // ── the column itself ─────────────────────────────────────────────────
    const iconUrl = (g) =>
        g && g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : null;

    function GuildTile({ id, selected, onClose }) {
        const g = safe(() => GuildStore.getGuild(id), null);
        if (!g) return null;
        const url = iconUrl(g);
        const initials = (g.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3);
        return h(
            Pressable,
            {
                onPress: () => {
                    (onClose || (() => setOpenFolder(null)))();
                    setTimeout(() => openGuild(id), 80);
                },
                style: { alignItems: "center", marginVertical: 5 },
            },
            h(View, {
                style: {
                    position: "absolute", left: -6, top: 12, width: 4, height: selected ? 24 : 0,
                    borderRadius: 2, backgroundColor: COLORS.text,
                },
            }),
            url
                ? h(Image, { source: { uri: url }, style: { width: 48, height: 48, borderRadius: selected ? 16 : 24 } })
                : h(
                      View,
                      {
                          style: {
                              width: 48, height: 48, borderRadius: selected ? 16 : 24,
                              backgroundColor: COLORS.tile, justifyContent: "center", alignItems: "center",
                          },
                      },
                      h(Text, { style: { color: COLORS.text, fontSize: 14, fontWeight: "600" } }, initials),
                  ),
        );
    }

    function FolderColumn() {
        const folderId = useOpenFolder();
        return h(ColumnView, { folderId, onClose: () => setOpenFolder(null) });
    }

    // The column layout itself (no Modal), so it can be drawn either inside an RN Modal (old
    // host mode) or directly inside Discord's alert layer (pop-up mode).
    function ColumnBody({ folder, onClose, dimRight, onColumnLayout }) {
        const selectedId = safe(() => SelectedGuildStore.getGuildId(), null);
        const left = typeof storage.columnLeft === "number" ? storage.columnLeft : barWidth;
        const tint = typeof folder.folderColor === "number" ? "#" + folder.folderColor.toString(16).padStart(6, "0") : COLORS.selected;
        return h(
            View,
            { style: { flex: 1, flexDirection: "row" } },
            // tap the server list area to close too
            h(Pressable, { style: { width: left }, onPress: () => onClose() }),
            h(
                View,
                {
                    onLayout: onColumnLayout,
                    style: {
                        width: 68, backgroundColor: COLORS.panel, paddingTop: 12, paddingBottom: 12,
                        marginTop: 52, marginBottom: 24, marginLeft: 4, borderRadius: 16,
                        borderWidth: 1, borderColor: COLORS.border, overflow: "hidden",
                    },
                },
                h(Image, {
                    source: asset("img_guild_folder"),
                    style: { alignSelf: "center", width: 24, height: 24, tintColor: tint, marginBottom: 8 },
                }),
                h(View, { style: { height: 1, marginHorizontal: 16, marginBottom: 6, backgroundColor: COLORS.border } }),
                h(
                    ScrollView,
                    { contentContainerStyle: { paddingVertical: 4 }, showsVerticalScrollIndicator: false },
                    (folder.guildIds || []).map((id) => h(GuildTile, { key: id, id, selected: id === selectedId, onClose })),
                ),
            ),
            h(Pressable, { style: { flex: 1, backgroundColor: dimRight ? "#00000055" : "transparent" }, onPress: () => onClose() }),
        );
    }

    function ColumnView({ folderId, onClose }) {
        const folder = folderId != null ? getFolder(folderId) : null;
        if (!folder) return null;
        return h(
            Modal,
            {
                transparent: true, visible: true, animationType: "fade",
                onRequestClose: () => onClose(),
                supportedOrientations: ["portrait", "landscape"],
            },
            h(ColumnBody, { folder, onClose, dimRight: true }),
        );
    }

    // Show the column through Kettu's custom alert API: Discord's alert manager is always
    // mounted, so this works without hooking any part of the server bar.
    // Look the alerts module up when it's needed, not at plugin start: on a fresh app start it may
    // not be loaded yet, and closing would silently do nothing (leaving Discord's dimmed backdrop).
    let alertsCache = null;
    const getAlerts = () => {
        if (!alertsCache) alertsCache = safe(() => metro.findByProps("openLazy", "close"), null);
        return alertsCache;
    };
    let alertOpenFor = null;
    function closeAlertColumn() {
        alertOpenFor = null;
        const A = getAlerts();
        const ok = safe(() => {
            A.close();
            return true;
        }, false);
        stats.lastClose = ok ? "closed" : "close failed (alerts module not found)";
    }
    // Drawn directly inside Discord's alert layer (no second pop-up: iOS refuses to present a
    // Modal on top of the alert). The alert's content area may be centred or padded, so we measure
    // where we ended up on screen and shift the column back to the real screen edges.
    // Safety rules, so the dimmed layer can never get stuck:
    //  - if the column hasn't been laid out 1.5 s after opening, close and open the folder normally;
    //  - tapping anywhere closes it; it also closes itself after 20 s without a tap;
    //  - after 2 failures in a row the column turns itself off (folders then open normally).
    function ColumnAlert({ folderId }) {
        const [open, setOpen] = React.useState(true);
        const [offset, setOffset] = React.useState({ x: 0, y: 0 });
        const rootRef = React.useRef(null);
        const shown = React.useRef(false);
        const closed = React.useRef(false);
        const folder = getFolder(folderId);
        const win = safe(() => ReactNative.Dimensions.get("window"), { width: 414, height: 896 });
        const close = (openFolderNormally) => {
            if (closed.current) return;
            closed.current = true;
            setOpen(false);
            closeAlertColumn();
            if (openFolderNormally) setTimeout(() => safe(() => !isExpanded(folderId) && toggle(folderId)), 150);
        };
        React.useEffect(() => {
            if (!folder) {
                stats.lastPopup = "folder not found";
                close(true);
                return undefined;
            }
            const watchdog = setTimeout(() => {
                if (shown.current || closed.current) return;
                storage.columnFails = (storage.columnFails || 0) + 1;
                stats.lastPopup = `column didn't appear (fail ${storage.columnFails})`;
                if (storage.columnFails >= 2) {
                    storage.column = false;
                    storage.columnAutoOff = true;
                    toast("BetterFolders: folder column turned off (it couldn't open). Folders open normally now.");
                } else toast("BetterFolders: column didn't open, opening the folder normally");
                close(true);
            }, 1500);
            const idle = setTimeout(() => {
                stats.lastPopup = "closed after 20 s idle";
                close(false);
            }, 20000);
            return () => {
                clearTimeout(watchdog);
                clearTimeout(idle);
            };
        }, []);
        if (!open || !folder) return null;
        const measure = () =>
            safe(() =>
                rootRef.current.measureInWindow((x, y) => {
                    if (typeof x !== "number" || typeof y !== "number") return;
                    stats.popupOrigin = `${Math.round(x)},${Math.round(y)}`;
                    if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) setOffset((o) => ({ x: o.x + x, y: o.y + y }));
                }),
            );
        return h(
            Pressable,
            { ref: rootRef, onLayout: measure, onPress: () => close(false), style: { width: win.width, height: win.height } },
            h(
                View,
                { style: { position: "absolute", left: -offset.x, top: -offset.y, width: win.width, height: win.height } },
                h(ColumnBody, {
                    folder,
                    dimRight: false, // Discord's alert already dims the screen
                    onClose: () => close(false),
                    onColumnLayout: (e) => {
                        const w = safe(() => e.nativeEvent.layout.width, 0);
                        if (w > 0 && !shown.current) {
                            shown.current = true;
                            storage.columnFails = 0;
                            stats.lastPopup = "column shown (inline)";
                        }
                    },
                }),
            ),
        );
    }
    // ── bottom sheet view (default): Discord's own action sheet, swipe down to close ──
    const SHEET_KEY = "betterfolders-folder";
    let sheetsCache = null;
    const getSheets = () => {
        if (!sheetsCache) sheetsCache = safe(() => metro.findByProps("openLazy", "hideActionSheet"), null);
        return sheetsCache;
    };
    const getActionSheet = () => safe(() => metro.findByProps("ActionSheet").ActionSheet, null);
    const closeSheet = () => safe(() => getSheets().hideActionSheet(SHEET_KEY));

    // unread / mention info, same source as the server bar
    // looked up when needed (not at plugin start), so a late-loading store can't silently break badges
    let readStoreCache = null;
    const getReadStore = () => readStoreCache || (readStoreCache = safe(() => metro.findByStoreName("GuildReadStateStore"), null));
    const mentionsOf = (id) => {
        const n = safe(() => getReadStore().getMentionCount(id), 0);
        return typeof n === "number" && n > 0 ? n : 0;
    };
    const unreadOf = (id) => !!safe(() => getReadStore().hasUnread(id), false);
    const BADGE = { red: "#CA6E8C", ring: "#16181D", text: "#FFFFFF" };
    const MentionBadge = ({ count, size }) =>
        h(
            View,
            {
                style: {
                    position: "absolute", right: size === "big" ? -4 : -6, bottom: -4,
                    minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 12,
                    backgroundColor: BADGE.red, borderWidth: 3, borderColor: BADGE.ring,
                    alignItems: "center", justifyContent: "center",
                },
            },
            h(Text, { style: { color: BADGE.text, fontSize: 12, fontWeight: "800" } }, count > 99 ? "99+" : String(count)),
        );

    function SheetTile({ id, selected }) {
        const g = safe(() => GuildStore.getGuild(id), null);
        if (!g) return null;
        const mentions = mentionsOf(id);
        const unread = !mentions && unreadOf(id);
        const url = iconUrl(g);
        const initials = (g.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3);
        const iconStyle = { width: 56, height: 56, borderRadius: selected ? 18 : 28 };
        return h(
            Pressable,
            {
                onPress: () => {
                    closeSheet();
                    setTimeout(() => openGuild(id), 120);
                },
                style: { width: "25%", alignItems: "center", paddingVertical: 8 },
            },
            h(
                View,
                { style: { width: 56, height: 56 } },
                url
                    ? h(Image, { source: { uri: url }, style: iconStyle })
                    : h(View, { style: [iconStyle, { backgroundColor: COLORS.tile, justifyContent: "center", alignItems: "center" }] },
                        h(Text, { style: { color: COLORS.text, fontSize: 15, fontWeight: "600" } }, initials)),
                mentions ? h(MentionBadge, { count: mentions }) : null,
                // small white dot for unread without mentions, like the server bar's unread pill
                unread ? h(View, { style: { position: "absolute", left: -10, top: 22, width: 6, height: 12, borderRadius: 3, backgroundColor: COLORS.text } }) : null,
            ),
            h(Text, { numberOfLines: 1, style: { color: selected || mentions || unread ? COLORS.text : COLORS.sub, fontSize: 11, marginTop: 6, maxWidth: 76, textAlign: "center" } }, g.name),
        );
    }

    function FolderSheet({ folderId }) {
        const [, force] = React.useReducer((x) => x + 1, 0);
        React.useEffect(() => {
            const RS = getReadStore();
            if (!RS || typeof RS.addChangeListener !== "function") return undefined;
            RS.addChangeListener(force);
            return () => safe(() => RS.removeChangeListener(force));
        }, []);
        const folder = getFolder(folderId);
        const total = folder ? (folder.guildIds || []).reduce((a, id) => a + mentionsOf(id), 0) : 0;
        stats.badges = getReadStore() ? "GuildReadStateStore ok" : "GuildReadStateStore missing";
        const selectedId = safe(() => SelectedGuildStore.getGuildId(), null);
        const tint = folder && typeof folder.folderColor === "number" ? "#" + folder.folderColor.toString(16).padStart(6, "0") : COLORS.selected;
        const body = !folder
            ? h(Text, { style: { color: COLORS.sub, padding: 24, textAlign: "center" } }, "Folder not found")
            : h(
                  View,
                  { style: { paddingHorizontal: 12, paddingBottom: 24 } },
                  h(
                      View,
                      { style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingTop: 4, paddingBottom: 12 } },
                      h(Image, { source: asset("img_guild_folder"), style: { width: 22, height: 22, tintColor: tint, marginRight: 10 } }),
                      h(Text, { numberOfLines: 1, style: { flex: 1, color: COLORS.text, fontSize: 17, fontWeight: "700" } }, folder.folderName || "Folder"),
                      total
                          ? h(View, { style: { minWidth: 24, height: 22, paddingHorizontal: 7, borderRadius: 11, backgroundColor: BADGE.red, alignItems: "center", justifyContent: "center", marginRight: 8 } },
                              h(Text, { style: { color: BADGE.text, fontSize: 12, fontWeight: "800" } }, total > 99 ? "99+" : String(total)))
                          : null,
                      h(Text, { style: { color: COLORS.sub, fontSize: 13 } }, `${(folder.guildIds || []).length} servers`),
                  ),
                  h(
                      View,
                      { style: { flexDirection: "row", flexWrap: "wrap" } },
                      (folder.guildIds || []).map((id) => h(SheetTile, { key: id, id, selected: id === selectedId })),
                  ),
              );
        const AS = getActionSheet();
        stats.lastPopup = AS ? "sheet shown" : "sheet shown (plain, ActionSheet missing)";
        return AS ? h(AS, null, body) : h(View, { style: { backgroundColor: COLORS.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16 } }, body);
    }

    function openSheetFolder(folderId) {
        const S = getSheets();
        const ok = safe(() => {
            S.openLazy(Promise.resolve({ default: FolderSheet }), SHEET_KEY, { folderId });
            return true;
        }, false);
        stats.alertMode = ok ? "sheet ok" : "sheet failed";
        return ok;
    }

    // which view a folder tap opens
    function openFolderView(folderId) {
        if (storage.columnPopup) return openAlertColumn(folderId);
        return openSheetFolder(folderId);
    }

    function openAlertColumn(folderId) {
        if (alertOpenFor === folderId) return closeAlertColumn();
        if (alertOpenFor != null) closeAlertColumn();
        const ok = safe(() => {
            vendetta.ui.alerts.showCustomAlert(ColumnAlert, { folderId });
            return true;
        }, false);
        if (ok) alertOpenFor = folderId;
        stats.alertMode = ok ? "ok" : "failed";
        return ok;
    }

    // Exactly one mounted host renders the column (it lives inside the server list).
    let ownerToken = null;
    const hostListeners = new Set();
    function ColumnHost() {
        const token = React.useRef({}).current;
        const [, force] = React.useReducer((x) => x + 1, 0);
        React.useEffect(() => {
            hostListeners.add(force);
            stats.hostMounted = true;
            if (!ownerToken) {
                ownerToken = token;
                force();
            }
            return () => {
                hostListeners.delete(force);
                if (ownerToken === token) {
                    ownerToken = null;
                    hostListeners.forEach((l) => safe(l));
                }
            };
        }, []);
        React.useEffect(() => {
            if (!ownerToken) ownerToken = token;
        });
        return ownerToken === token && storage.column ? h(FolderColumn) : null;
    }

    // ── feature 2: hook Discord's server bar (found by source file path) ──
    const PATHS = {
        bar: "modules/guilds_bar/native/GuildsBar.tsx",
        folder: "modules/guilds_bar/native/GuildsBarGuildFolder.tsx",
        consts: "modules/guilds_bar/native/GuildsBarConstants.tsx",
        guildIcon: "uikit-native/GuildIcon.tsx",
        pile: "design/components/Pile/native/GuildIconPile.native.tsx",
        guild: "modules/guilds_bar/native/GuildsBarGuild.tsx",
        pressable: "modules/guilds_bar/native/GuildsBarItemIconPressable.tsx",
        drawerRow: "modules/home_drawer/native/HomeDrawerFolderRow.tsx",
        itemWrapper: "modules/guilds_bar/native/GuildsBarAnimatedItemWrapper.tsx",
        messages: "modules/messages/native/Messages.tsx",
    };
    const ID_HINTS = {
        "modules/guilds_bar/native/GuildsBar.tsx": 12999,
        "modules/guilds_bar/native/GuildsBarGuildFolder.tsx": 13011,
        "modules/guilds_bar/native/GuildsBarConstants.tsx": 13002,
        "uikit-native/GuildIcon.tsx": 5954,
        "design/components/Pile/native/GuildIconPile.native.tsx": 10945,
        "modules/guilds_bar/native/GuildsBarGuild.tsx": 13035,
        "modules/guilds_bar/native/GuildsBarItemIconPressable.tsx": 13062,
        "modules/home_drawer/native/HomeDrawerFolderRow.tsx": 13022,
        "modules/guilds_bar/native/GuildsBarAnimatedItemWrapper.tsx": 13012,
    };
    const allMods = () => safe(() => vendetta.metro.modules || window.modules, {}) || {};
    function modByPath(path) {
        const mods = allMods();
        // fast path: id remembered from a previous run
        const known = (storage.ids && storage.ids[path]) != null ? storage.ids[path] : ID_HINTS[path];
        if (known != null && mods[known] && mods[known].__filePath === path)
            return safe(() => mods[known].publicModule.exports, null);
        for (const id in mods) {
            const m = mods[id];
            if (m && m.__filePath === path) {
                if (!storage.ids) storage.ids = {};
                storage.ids[path] = Number(id);
                return safe(() => m.publicModule.exports, null);
            }
        }
        return null;
    }

    // Load remembered modules early so we can patch them before Discord first draws the server bar.
    function preloadKnownModules() {
        const ids = Object.assign({}, ID_HINTS, storage.ids || {});
        let n = 0;
        for (const path in ids) {
            const id = ids[path];
            const m = allMods()[id];
            if (!m) continue;
            if (!m.isInitialized) safe(() => (window.__r ? window.__r(id) : null));
            if (allMods()[id] && allMods()[id].__filePath === path) n++;
        }
        return n;
    }

    // patch a component whatever its wrapper is (memo / forwardRef / plain fn)
    function patchComponent(comp, cb) {
        if (!comp) return null;
        if (comp.type && typeof comp.type.render === "function") return patcher.after("render", comp.type, cb);
        if (typeof comp.render === "function") return patcher.after("render", comp, cb);
        if (typeof comp.type === "function") return patcher.after("type", comp, cb);
        return null;
    }

    const folderIcon = (tint) =>
        h(
            View,
            { style: { overflow: "hidden", borderRadius: 16, height: 48, width: 48, justifyContent: "center", alignItems: "center" } },
            h(Image, { source: asset("img_guild_folder"), style: tint ? { tintColor: tint } : {} }),
        );
    const pick = (...vals) => {
        for (const v of vals) if (v !== undefined && v !== null) return v;
        return undefined;
    };
    const toHex = (n) => (typeof n === "number" ? "#" + n.toString(16).padStart(6, "0") : n);

    const known = new Map(); // component -> label, for readable diagnostics
    const labelOf = (t) => {
        if (typeof t === "string") return t;
        if (!t) return String(t);
        if (known.has(t)) return known.get(t);
        return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && t.render.name) || (t.$$typeof ? "memo/fwd" : typeof t);
    };
    function outline(node, depth = 0, out = []) {
        if (out.length > 60 || depth > 6 || node == null || typeof node !== "object") return out;
        if (Array.isArray(node)) {
            node.forEach((n) => outline(n, depth, out));
            return out;
        }
        if (!node.props) return out;
        const keys = Object.keys(node.props).filter((k) => k !== "children").slice(0, 8).join(",");
        out.push(`${"  ".repeat(depth)}${labelOf(node.type)} {${keys}}`);
        outline(node.props.children, depth + 1, out);
        return out;
    }
    const diag = { folderProps: "", folderTree: "", barTree: "", hideResult: "not tried", rowProps: "", rowTree: "" };

    // replace the first element whose subtree holds 2+ guild icons with a folder icon
    function hideInTree(root, tint, iconTypes) {
        let replaced = false;
        const count = (n) => {
            if (n == null || typeof n !== "object") return 0;
            if (Array.isArray(n)) return n.reduce((a, c) => a + count(c), 0);
            if (!n.props) return 0;
            return (iconTypes.has(n.type) ? 1 : 0) + count(n.props.children);
        };
        const walk = (n, parent, key) => {
            if (replaced || n == null || typeof n !== "object") return;
            if (Array.isArray(n)) return n.forEach((c, i) => walk(c, n, i));
            if (!n.props) return;
            if (n.type && iconTypes.has(n.type) && n.type === iconTypes.pile) {
                parent[key] = folderIcon(tint);
                replaced = true;
                return;
            }
            const kids = n.props.children;
            if (count(kids) >= 2 && !(Array.isArray(kids) ? kids : [kids]).some((k) => count(k) >= 2)) {
                n.props.children = folderIcon(tint);
                replaced = true;
                return;
            }
            if (Array.isArray(kids)) kids.forEach((c, i) => walk(c, kids, i));
            else if (kids && typeof kids === "object") walk(kids, n.props, "children");
        };
        walk(root, { root }, "root");
        return replaced;
    }

    // Mount the column host on the chat view. Kettu patches this same component for theme
    // backgrounds; its render is looked up on every draw, so it works mid-session.
    let msgHooked = false;
    function hookMessages() {
        if (msgHooked) return true;
        const msgMod = modByPath(PATHS.messages);
        const msg = msgMod && msgMod.default;
        if (!msg) {
            stats.msgHook = "waiting: chat view not loaded yet";
            return false;
        }
        const onMsg = (args, res) => {
            stats.msgRenders = (stats.msgRenders || 0) + 1;
            if (!res) return res;
            stats.hostAttached++;
            stats.attachMode = "Messages";
            return h(React.Fragment, null, res, h(ColumnHost, { key: "bf-column-host" }));
        };
        let unMsg = null, how = "failed";
        if (typeof msg.render === "function") { unMsg = patcher.after("render", msg, onMsg); how = "render"; }
        else if (msg.prototype && typeof msg.prototype.render === "function") { unMsg = patcher.after("render", msg.prototype, onMsg); how = "prototype"; }
        else if (msg.type && typeof msg.type.render === "function") { unMsg = patcher.after("render", msg.type, onMsg); how = "memo.render"; }
        else { unMsg = patchComponent(msg, onMsg); how = unMsg ? "component" : `failed (${typeof msg}, keys ${safe(() => Object.keys(msg).join(","), "")})`; }
        if (!unMsg) {
            stats.msgHook = how;
            return false;
        }
        unpatches.push(unMsg);
        stats.msgHook = how;
        msgHooked = true;
        return true;
    }

    let msgTimer = null;
    function hookMessagesWhenReady() {
        let tries = 0;
        const attempt = () => {
            if (stopped || safe(hookMessages, false)) return;
            if (++tries < 300) msgTimer = setTimeout(attempt, 1000);
        };
        attempt();
    }

    // find a folder id anywhere shallow in an item's props (we don't know Discord's prop names yet)
    function folderIdFromProps(props, folderIds) {
        const seen = new Set();
        let found = null;
        const visit = (v, depth) => {
            if (found != null || v == null || depth > 3) return;
            if (typeof v === "number" || typeof v === "string") {
                if (folderIds.has(String(v))) found = v;
                return;
            }
            if (typeof v !== "object" || seen.has(v) || v.$$typeof) return;
            seen.add(v);
            for (const k of ["folderId", "id", "key", "nodeId"]) if (k in v) visit(safe(() => v[k]), depth + 1);
            if (found != null) return;
            for (const k of Object.keys(v).slice(0, 25)) {
                if (k === "children" || k === "style") continue;
                const x = safe(() => v[k]);
                if (x && typeof x === "object") visit(x, depth + 1);
            }
        };
        visit(props, 0);
        return found;
    }

    const FolderCellOverlay = ({ folder }) => {
        const tint = typeof folder.folderColor === "number" ? "#" + folder.folderColor.toString(16).padStart(6, "0") : COLORS.selected;
        const total = (folder.guildIds || []).reduce((a, id) => a + mentionsOf(id), 0);
        return h(
            View,
            {
                pointerEvents: "none",
                // solid backing in the server bar's colour so none of Discord's mini icons show around
                // the edges (measured: folder square ~50pt wide; bar #16181D). Left 8pt stays clear for
                // Discord's white unread/selected bar.
                style: {
                    position: "absolute", top: 0, bottom: 0, left: 8, right: 8,
                    backgroundColor: "#16181D", alignItems: "center", justifyContent: "center",
                },
            },
            storage.folderNames !== false
                ? h(Text, { numberOfLines: 1, style: { width: 56, textAlign: "center", color: COLORS.text, fontSize: 9, fontWeight: "700", marginBottom: 1 } }, folder.folderName || "Folder")
                : null,
            h(
                View,
                {
                    style: {
                        width: storage.folderNames !== false ? 44 : 48, height: storage.folderNames !== false ? 44 : 48,
                        borderRadius: 14, backgroundColor: COLORS.tile, alignItems: "center", justifyContent: "center",
                    },
                },
                h(Image, { source: asset("img_guild_folder"), style: { width: 22, height: 22, tintColor: tint } }),
                total
                    ? h(View, { style: { position: "absolute", right: -6, bottom: -4, minWidth: 20, height: 20, paddingHorizontal: 4, borderRadius: 10, backgroundColor: BADGE.red, borderWidth: 2, borderColor: BADGE.ring, alignItems: "center", justifyContent: "center" } },
                        h(Text, { style: { color: BADGE.text, fontSize: 10, fontWeight: "800" } }, total > 99 ? "99+" : String(total)))
                    : null,
            ),
        );
    };

    function hookItemWrapper() {
        const mod = modByPath(PATHS.itemWrapper);
        if (!mod || typeof mod.default !== "function") {
            stats.cells = "item wrapper not found";
            return;
        }
        const un = patcher.after("default", mod, ([props], res) => {
            stats.cellRenders = (stats.cellRenders || 0) + 1;
            if (!stats.cellProps) stats.cellProps = safe(() => Object.keys(props || {}).join(","), "?");
            if (!storage.hideIcons || !res) return res;
            const folders = getFolders() || [];
            const ids = new Set(folders.filter((f) => f.folderId != null).map((f) => String(f.folderId)));
            if (!ids.size) return res;
            const fid = folderIdFromProps(props, ids);
            if (fid == null) return res;
            if (isExpanded(fid)) return res; // open folders look normal
            const folder = folders.find((f) => String(f.folderId) === String(fid));
            if (!folder) return res;
            stats.folderCells = (stats.folderCells || 0) + 1;
            return h(View, { style: { position: "relative" } }, res, h(FolderCellOverlay, { folder }));
        });
        unpatches.push(un);
        stats.cells = "hooked";
    }

    function startGuildContainerPatch() {
        const barMod = modByPath(PATHS.bar);
        if (!barMod || !barMod.default) {
            status.hideIcons = status.column = "waiting: server bar not loaded yet";
            return false;
        }

        // readable names for diagnostics + icon detection
        const gi = safe(() => modByPath(PATHS.guildIcon).default);
        const pile = safe(() => modByPath(PATHS.pile).GuildIconPile);
        const gg = safe(() => modByPath(PATHS.guild).default);
        const pr = safe(() => modByPath(PATHS.pressable).default);
        const folderMod = modByPath(PATHS.folder);
        [[gi, "GuildIcon"], [pile, "GuildIconPile"], [gg, "GuildsBarGuild"], [pr, "ItemIconPressable"],
         [barMod.default, "GuildsBar"], [folderMod && folderMod.default, "GuildsBarGuildFolder"],
         [folderMod && folderMod.GuildsBarGuildFolderBG, "GuildFolderBG"]].forEach(([c, n]) => c && known.set(c, n));
        const iconTypes = new Set([gi, pile, gg].filter(Boolean));
        iconTypes.pile = pile;

        const width = safe(() => modByPath(PATHS.consts).GUILD_LIST_WIDTH);
        if (typeof width === "number") barWidth = width;

        // 1) mount the column host next to the server bar
        const unBar = patchComponent(barMod.default, (args, res) => {
            stats.renders++;
            if (!diag.barTree) diag.barTree = outline(res).slice(0, 12).join("\n");
            if (!res) return res;
            stats.hostAttached++;
            stats.attachMode = "GuildsBar";
            return h(React.Fragment, null, res, h(ColumnHost, { key: "bf-column-host" }));
        });
        if (unBar) unpatches.push(unBar);
        status.column = unBar ? (status.autoCollapse === "ok" ? "ok (GuildsBar hooked)" : status.autoCollapse) : "failed: couldn't patch GuildsBar";

        // 2) hide icons in collapsed folders
        const unFolder = folderMod && folderMod.default
            ? patchComponent(folderMod.default, ([props], res) => {
                  safe(() => {
                      if (!diag.folderProps) diag.folderProps = Object.keys(props || {}).join(",");
                      if (!diag.folderTree) diag.folderTree = outline(res).join("\n");
                      if (!storage.hideIcons || !res) return;
                      const fid = pick(safe(() => props.folderNode.id), safe(() => props.folder.folderId), safe(() => props.folderId), safe(() => props.node.id));
                      const expanded = pick(props.expanded, props.isExpanded, fid != null ? isExpanded(fid) : false);
                      if (expanded) return;
                      const folder = fid != null ? getFolder(fid) : null;
                      const color = toHex(pick(folder ? folder.folderColor : undefined, safe(() => props.folderNode.color), safe(() => props.folderColor)));
                      const ok = hideInTree(res, color, iconTypes);
                      diag.hideResult = ok ? "replaced" : "no icon group in output";
                      if (ok) stats.previewPatched++;
                  });
                  return res;
              })
            : null;
        if (unFolder) unpatches.push(unFolder);

        // 4) server bar items: GuildsBarAnimatedItemWrapper wraps every bar item (folders too) and is a
        //    plain function, so it applies mid-session. For closed folders we lay a folder icon + the
        //    folder's name over the mini server icons. pointerEvents "none": taps still reach Discord.
        safe(hookItemWrapper);

        // 3) home drawer layout (newer Discord): folder rows are a plain function component
        const rowMod = modByPath(PATHS.drawerRow);
        if (rowMod && typeof rowMod.default === "function") {
            known.set(rowMod.default, "HomeDrawerFolderRow");
            const unRow = patcher.after("default", rowMod, ([props], res) => {
                stats.rowRenders = (stats.rowRenders || 0) + 1;
                safe(() => {
                    if (!diag.rowProps) diag.rowProps = Object.keys(props || {}).join(",") + " | " + safe(() => JSON.stringify(props, (k, v) => (typeof v === "function" ? "fn" : v && typeof v === "object" && v.$$typeof ? "<el>" : v)).slice(0, 400), "");
                    if (!diag.rowTree) diag.rowTree = outline(res).join("\n");
                    if (!storage.hideIcons || !res) return;
                    const fid = pick(safe(() => props.folderNode.id), safe(() => props.folder.folderId), safe(() => props.folder.id), safe(() => props.folderId), safe(() => props.node.id), safe(() => props.item.id));
                    const expanded = pick(props.expanded, props.isExpanded, fid != null ? isExpanded(fid) : false);
                    if (expanded) return;
                    const folder = fid != null ? getFolder(fid) : null;
                    const color = toHex(pick(folder ? folder.folderColor : undefined, safe(() => props.folder.color), safe(() => props.folderColor)));
                    const ok = hideInTree(res, color, iconTypes);
                    diag.hideResult = ok ? "replaced (drawer)" : "no icon group in drawer row";
                    if (ok) stats.previewPatched++;
                });
                if (!res) return res;
                stats.hostAttached++;
                stats.attachMode = "HomeDrawerFolderRow";
                return h(React.Fragment, null, res, h(ColumnHost, { key: "bf-column-host" }));
            });
            unpatches.push(unRow);
            status.hideIcons += " + drawer row";
            if (status.column.startsWith("ok")) status.column = "ok (GuildsBar + drawer hooked)";
        }
        status.hideIcons = unFolder ? "hooked (GuildsBarGuildFolder)" : "failed: folder component not found";
        return true;
    }
    let barWidth = 64;

    let retryTimer = null;
    let stopped = false;
    function patchWhenReady() {
        let tries = 0;
        const attempt = () => {
            if (stopped) return;
            tries++;
            if (safe(startGuildContainerPatch, false)) {
                setTimeout(refreshFolders, 200);
                return;
            }
            if (tries >= 120) {
                status.hideIcons = "failed: GuildContainer not found after 2 min";
                status.column = "failed: nowhere to mount (GuildContainer not found)";
                return;
            }
            retryTimer = setTimeout(attempt, 1000);
        };
        attempt();
    }

    // ── scanner: list Discord modules related to guild folders ────────────
    function scanDiscord() {
        safe(hookMessages);
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        const out = [];
        let total = 0, withPath = 0;
        const RX = /folder|guilds?_?bar|guild_?list|guilds?nav|guildsidebar|server_?list|guild_?item|guildicon|home_drawer|messages\/native\/Messages/i;
        for (const id in mods) {
            total++;
            const m = mods[id];
            const path = m && m.__filePath;
            if (!path) continue;
            withPath++;
            if (!RX.test(path)) continue;
            const exp = safe(() => m.publicModule && m.publicModule.exports);
            let desc = "";
            safe(() => {
                if (!exp) return (desc = "no exports");
                const keys = Object.keys(exp).slice(0, 12);
                desc = keys
                    .map((k) => {
                        const v = exp[k];
                        const t = typeof v === "function" ? "fn" : v && typeof v === "object" ? (v.$$typeof ? "memo/fwd" : "obj") : typeof v;
                        return `${k}:${t}`;
                    })
                    .join(",");
            });
            out.push(`${id} ${path} [${desc}]`);
        }
        out.unshift(`--- popup ${stats.alertMode || "unused"} (alerts api ${getAlerts() ? "found" : "missing"}, last close: ${stats.lastClose || "none"}) · chat hook ${stats.msgHook} · chat renders ${stats.msgRenders || 0} · preloaded ${stats.preloaded || 0} · bar renders ${stats.renders} · drawer row renders ${stats.rowRenders || 0} · host ${stats.hostMounted ? "mounted" : "not mounted"}`, `--- drawer row props: ${diag.rowProps}`, `--- drawer row tree:\n${diag.rowTree}`, `--- folder props: ${diag.folderProps}`, `--- hide result: ${diag.hideResult} · bar width ${barWidth}`, `--- folder tree:\n${diag.folderTree}`, `--- bar tree:\n${diag.barTree}`, `--- paths:`);
        return `BetterFolders ${VERSION} scan: ${out.length} matches (${withPath}/${total} modules have paths)\n` + (out.slice(0, 120).join("\n") || "nothing found");
    }

    // ── settings page (plain React Native, no internal helpers) ───────────
    function Row({ label, sub, value, onChange }) {
        return h(
            Pressable,
            {
                onPress: () => onChange(!value),
                style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14 },
            },
            h(
                View,
                { style: { flex: 1, paddingRight: 12 } },
                h(Text, { style: { color: COLORS.text, fontSize: 16, fontWeight: "600" } }, label),
                h(Text, { style: { color: COLORS.sub, fontSize: 13, marginTop: 2 } }, sub),
            ),
            h(Switch, { value, onValueChange: onChange }),
        );
    }

    function Stepper({ label, value, onChange }) {
        const btn = (t, d) =>
            h(
                Pressable,
                {
                    onPress: () => onChange(value + d),
                    style: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.tile, marginLeft: 8 },
                },
                h(Text, { style: { color: COLORS.text, fontSize: 16 } }, t),
            );
        return h(
            View,
            { style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 } },
            h(Text, { style: { flex: 1, color: COLORS.text, fontSize: 15 } }, `${label}: ${value}`),
            btn("−", -4),
            btn("+", 4),
        );
    }

    function Settings() {
        const [, force] = React.useReducer((x) => x + 1, 0);
        const [scan, setScan] = React.useState(null);
        const runScan = () => {
            const out = safe(scanDiscord, "scan failed");
            setScan(out);
            const ok = safe(() => {
                metro.common.clipboard.setString(out);
                return true;
            }, false);
            toast(ok ? "Scan copied to clipboard - paste it to Claude" : "Scan done - screenshot the list");
        };
        const set = (key) => (v) => {
            storage[key] = v;
            if (key === "hideIcons") setTimeout(refreshFolders, 100);
            if (key === "column" && !v) setOpenFolder(null);
            if (key === "column" && v) storage.columnFails = 0;
            force();
        };
        const line = (t) => h(Text, { style: { color: COLORS.sub, fontSize: 12, paddingHorizontal: 16, marginTop: 4 } }, t);

        return h(
            ScrollView,
            { style: { flex: 1, paddingTop: 10 } },
            h(Row, {
                label: "Open folders in their own view",
                sub: "Tapping a folder keeps it closed and shows its servers in a panel. Off = folders open normally.",
                value: !!storage.column,
                onChange: set("column"),
            }),
            storage.column
                ? h(Row, {
                      label: "Use column instead of bottom sheet (experimental)",
                      sub: "Vencord-style side column. Didn't display on your iPhone in 1.5-1.6; the bottom sheet is the reliable option.",
                      value: !!storage.columnPopup,
                      onChange: set("columnPopup"),
                  })
                : null,
            storage.column && storage.columnPopup
                ? h(Stepper, {
                      label: "Column position",
                      value: typeof storage.columnLeft === "number" ? storage.columnLeft : barWidth,
                      onChange: (v) => set("columnLeft")(Math.max(0, Math.min(200, v))),
                  })
                : null,
            h(Row, {
                label: "Auto collapse",
                sub: "Close other folders when you open one (when the column is off).",
                value: !!storage.autoCollapse,
                onChange: set("autoCollapse"),
            }),
            h(Row, {
                label: "Hide icons",
                sub: "Show a plain folder icon instead of server icons in collapsed folders.",
                value: !!storage.hideIcons,
                onChange: set("hideIcons"),
            }),
            storage.hideIcons
                ? h(Row, {
                      label: "Show folder name",
                      sub: "Small folder name above the folder icon in the server bar.",
                      value: storage.folderNames !== false,
                      onChange: (v) => {
                          storage.folderNames = v;
                          force();
                      },
                  })
                : null,
            h(View, { style: { height: 16 } }),
            line(`BetterFolders ${VERSION} diagnostics`),
            line(`Folder column: ${status.column}`),
            line(`Open server via: ${status.nav}`),
            line(`Auto collapse: ${status.autoCollapse}`),
            line(`Hide icons: ${status.hideIcons}`),
            line(`popup ${stats.alertMode || "unused"} (alerts api ${getAlerts() ? "found" : "missing"}, last close: ${stats.lastClose || "none"}, last popup: ${stats.lastPopup || "none"}, origin ${stats.popupOrigin || "?"})`),
            line(`badges: ${stats.badges || "sheet not opened yet"}`),
            line(`bar items: ${stats.cells || "not started"} · drawn ${stats.cellRenders || 0} · folder icons ${stats.folderCells || 0} · props ${stats.cellProps || "?"}`),
            line(`chat hook ${stats.msgHook} · chat renders ${stats.msgRenders || 0} · host ${stats.hostMounted ? "mounted" : "not mounted"}`),
            line(`preloaded ${stats.preloaded || 0} · renders ${stats.renders} · preview ${stats.previewPatched} · attached ${stats.hostAttached} (${stats.attachMode}) · host ${stats.hostMounted ? "mounted" : "not mounted"}`),
            h(
                Pressable,
                {
                    onPress: runScan,
                    style: { margin: 16, padding: 14, borderRadius: 12, backgroundColor: COLORS.selected, alignItems: "center" },
                },
                h(Text, { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" } }, "Scan Discord (copies result)"),
            ),
            scan ? h(Text, { selectable: true, style: { color: COLORS.sub, fontSize: 11, paddingHorizontal: 16, paddingBottom: 40, fontFamily: "Menlo" } }, scan) : null,
        );
    }

    return {
        onLoad() {
            if (storage.hideIcons === undefined) storage.hideIcons = true;
            if (storage.autoCollapse === undefined) storage.autoCollapse = true;
            if (storage.column === undefined) storage.column = true;
            safe(startFolderEvents);
            stopped = false;
            stats.preloaded = safe(preloadKnownModules, 0);
            msgHooked = false;
            hookMessagesWhenReady();
            patchWhenReady();
            if (status.autoCollapse !== "ok") status.column = status.autoCollapse;
            setTimeout(() => {
                // start with every folder closed so the column is the only way folders open
                if (storage.column)
                    safe(() => (getFolders() || []).forEach((f) => f.folderId && isExpanded(f.folderId) && toggle(f.folderId)));
                refreshFolders();
            }, 300);
            const msg = `BetterFolders ${VERSION} | column: ${status.column} | icons: ${status.hideIcons}`;
            safe(() => logger.log(msg));
            // only announce once per version, not on every app start
            if (storage.announcedVersion !== VERSION) {
                storage.announcedVersion = VERSION;
                // 1.5.3 switched the column off without remembering why; treat 2+ failures as automatic
                const autoOff = storage.columnAutoOff || (storage.column === false && (storage.columnFails || 0) >= 2);
                storage.columnFails = 0;
                if (autoOff) {
                    storage.columnAutoOff = false;
                    storage.column = true;
                }
                toast(`BetterFolders updated to ${VERSION}`);
            }
        },
        onUnload() {
            stopped = true;
            if (retryTimer) clearTimeout(retryTimer);
            if (msgTimer) clearTimeout(msgTimer);
            setOpenFolder(null);
            unpatches.splice(0).forEach((u) => safe(u));
            setTimeout(refreshFolders, 100);
        },
        settings: Settings,
    };
})()
