(() => {
    "use strict";
    // Read As You Go - step 1: listen only.
    // Records which events Discord's native chat view (DCDChat) sends while you scroll, and what they
    // contain, so step 2 can mark messages read up to the last one you've actually seen.
    // Every wrapped callback calls Discord's original first and returns its result unchanged.

    const { metro, patcher, plugin } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative } = metro.common;
    const { View, Text, Pressable, ScrollView } = ReactNative;
    const h = React.createElement;

    const VERSION = "0.1.0";
    const CHAT = "modules/chat/native/Chat.ios.tsx";
    const COLORS = { text: "#E3E8F4", sub: "#8592AD", btn: "#3673CB" };

    const safe = (fn, fb) => {
        try {
            const r = fn();
            return r === undefined ? fb : r;
        } catch (e) {
            return fb;
        }
    };
    const toast = (m) => safe(() => vendetta.ui.toasts.showToast(m));
    const status = { hook: "not started", renders: 0, propNames: "" };
    const events = {}; // name -> { count, sample }
    const unpatches = [];

    function exportsByPath(path) {
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        for (const id in mods) {
            const m = mods[id];
            if (m && m.__filePath === path) return safe(() => m.publicModule.exports, null);
        }
        return null;
    }

    // short description of an event argument: keys, small values, array sizes, first array item keys
    function describe(v, depth) {
        depth = depth || 0;
        if (v == null) return String(v);
        if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v);
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (typeof v === "function") return "fn";
        if (Array.isArray(v)) return `[${v.length}]${v.length && depth < 2 ? " of " + describe(v[0], depth + 1) : ""}`;
        if (typeof v === "object") {
            if (depth > 2) return "{…}";
            const keys = safe(() => Object.keys(v), []).slice(0, 14);
            return "{" + keys.map((k) => `${k}:${describe(safe(() => v[k]), depth + 1)}`).join(", ") + "}";
        }
        return typeof v;
    }

    const wrapped = new WeakMap();
    function wrap(name, fn) {
        if (wrapped.has(fn)) return wrapped.get(fn);
        const w = function () {
            const r = fn.apply(this, arguments);
            safe(() => {
                const e = events[name] || (events[name] = { count: 0, sample: "" });
                e.count++;
                // keep the latest sample (truncated); nativeEvent is where native views put their data
                const a = arguments[0];
                const payload = a && a.nativeEvent ? a.nativeEvent : a;
                e.sample = describe(payload).slice(0, 700);
            });
            return r;
        };
        wrapped.set(fn, w);
        return w;
    }

    function hookChat() {
        if (status.hook === "ok") return true;
        const exp = exportsByPath(CHAT);
        const comp = exp && exp.default;
        if (!comp || typeof comp.render !== "function") {
            status.hook = "waiting: chat not loaded yet";
            return false;
        }
        unpatches.push(
            patcher.after("render", comp, (args, res) => {
                status.renders++;
                if (!res || !res.props) return res;
                // never edit Discord's element in place (props can be read-only): return a copy with
                // each callback wrapped; everything else is passed through untouched
                return safe(() => {
                    const names = Object.keys(res.props).filter((k) => typeof res.props[k] === "function");
                    status.propNames = names.join(", ");
                    const next = {};
                    for (const k of names) next[k] = wrap(k, res.props[k]);
                    return React.cloneElement(res, next);
                }, res);
            }),
        );
        status.hook = "ok";
        return true;
    }

    function report() {
        const rows = Object.keys(events)
            .sort((a, b) => events[b].count - events[a].count)
            .map((k) => `${events[k].count}× ${k}: ${events[k].sample}`);
        return [
            `Read As You Go ${VERSION} report · chat hook ${status.hook} · chat draws ${status.renders}`,
            `chat callbacks: ${status.propNames || "(none seen yet)"}`,
            "--- events while you used the chat:",
            rows.join("\n") || "(no events yet - open a chat and scroll up and down)",
        ].join("\n");
    }

    function Settings() {
        const [out, setOut] = React.useState(null);
        const btn = (label, onPress) =>
            h(Pressable, { onPress, style: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 12, backgroundColor: COLORS.btn, alignItems: "center" } },
                h(Text, { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" } }, label));
        return h(
            ScrollView,
            { style: { flex: 1 } },
            h(Text, { style: { color: COLORS.sub, fontSize: 14, padding: 16, lineHeight: 20 } },
                "Step 1 only listens and changes nothing. Open a chat with lots of unread messages, scroll up and down slowly for 10 seconds, then come back here, tap Copy report and paste it to Claude."),
            btn("Copy report", () => {
                const r = report();
                setOut(r);
                const ok = safe(() => {
                    metro.common.clipboard.setString(r);
                    return true;
                }, false);
                toast(ok ? "Report copied - paste it to Claude" : "Screenshot the report below");
            }),
            btn("Clear recorded events", () => {
                Object.keys(events).forEach((k) => delete events[k]);
                setOut(null);
                toast("Cleared");
            }),
            out ? h(Text, { selectable: true, style: { color: COLORS.sub, fontSize: 11, padding: 16, paddingBottom: 40, fontFamily: "Menlo" } }, out) : null,
        );
    }

    let timer = null;
    let stopped = false;
    return {
        onLoad() {
            stopped = false;
            let tries = 0;
            const loop = () => {
                if (stopped || safe(hookChat, false)) return;
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
