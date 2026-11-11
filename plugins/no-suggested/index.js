(() => {
    "use strict";
    // No Suggested - hides the "Suggested" channels section in a server's channel list.
    // It only hides it on your screen: nothing is sent to Discord.
    // Two ways of finding it, because Discord renames things between versions:
    //  A) any loaded module exporting a "SuggestedCategory" component (what the old No Suggestions used)
    //  B) components (capitalised exports, never hooks) in channel-list files with "suggest" in the path
    // Every hidden component is made to draw nothing (null), which React always accepts.

    const { metro, patcher, plugin } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative } = metro.common;
    const { Text, Pressable, ScrollView } = ReactNative;
    const h = React.createElement;

    const VERSION = "0.1.0";
    const COLORS = { sub: "#8592AD", btn: "#3673CB" };

    const safe = (fn, fb) => {
        try {
            const r = fn();
            return r === undefined ? fb : r;
        } catch (e) {
            return fb;
        }
    };
    const toast = (m) => safe(() => vendetta.ui.toasts.showToast(m));
    const unpatches = [];
    const patched = []; // "path :: name" of everything hidden
    const done = new WeakMap(); // owner object -> keys already hidden (patching replaces owner[key])
    const isDone = (o, k) => !!(done.get(o) && done.get(o)[k]);
    const markDone = (o, k) => {
        const d = done.get(o) || {};
        d[k] = true;
        done.set(o, d);
    };
    const status = { scans: 0, hidden: 0 };

    const allModules = () => safe(() => vendetta.metro.modules || window.modules, {}) || {};
    const loadedExports = (m) => safe(() => (m.isInitialized === false ? null : m.publicModule.exports), null);

    // make one component draw nothing; works for plain functions, forwardRef and memo
    function hide(owner, key, label) {
        const c = safe(() => owner[key], null);
        if (!c || isDone(owner, key)) return false;
        let ok = false;
        if (typeof c === "function") {
            unpatches.push(patcher.instead(key, owner, () => null));
            ok = true;
        } else if (typeof c === "object") {
            if (typeof c.render === "function") {
                unpatches.push(patcher.instead("render", c, () => null));
                ok = true;
            } else if (c.type) {
                ok = hide(c, "type", null); // counted once, below, by the outer call
            }
        }
        if (ok) {
            markDone(owner, key);
            if (label) {
                patched.push(label);
                status.hidden++;
            }
        }
        return ok;
    }

    // never hide hooks, or wrappers that could hold the whole channel list inside them
    const isComponentName = (k) => /^[A-Z]/.test(k) && !/^use/.test(k) && !/Provider|Context|Wrapper|Container|Store/.test(k);
    const suggestPath = (p) => /suggest/i.test(p) && /channel/i.test(p) && /\.tsx$/.test(p);

    function scan() {
        status.scans++;
        const mods = allModules();
        for (const id in mods) {
            const m = mods[id];
            const exp = m && loadedExports(m);
            if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;
            const path = safe(() => m.__filePath, "") || "";
            // A) the known component name, wherever it lives
            if (safe(() => exp.SuggestedCategory, null)) safe(() => hide(exp, "SuggestedCategory", `${path || id} :: SuggestedCategory`));
            // B) components in channel-list "suggest" files
            if (path && suggestPath(path)) {
                const keys = safe(() => Object.keys(exp), []);
                for (const k of keys) {
                    if (k === "default") {
                        const d = safe(() => exp.default, null);
                        const name = safe(() => d.name || d.displayName || (d.type && (d.type.name || d.type.displayName)) || "", "");
                        // only hide a default export that looks like a component, never a hook/helper
                        if (d && name && isComponentName(name)) safe(() => hide(exp, "default", `${path} :: default (${name})`));
                    } else if (isComponentName(k) && /suggest/i.test(k)) {
                        safe(() => hide(exp, k, `${path} :: ${k}`));
                    }
                }
            }
        }
    }

    function report() {
        const mods = allModules();
        const paths = [];
        for (const id in mods) {
            const p = safe(() => mods[id].__filePath, "") || "";
            if (/suggest/i.test(p)) paths.push(`${loadedExports(mods[id]) ? "loaded" : "not loaded"} · ${p}`);
        }
        return [
            `No Suggested ${VERSION} report · scans ${status.scans} · hidden ${status.hidden}`,
            "--- hidden:",
            patched.join("\n") || "(nothing yet - open a server that shows Suggested, then copy again)",
            "--- every module with 'suggest' in its path:",
            paths.sort().join("\n") || "(none)",
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
                `Hidden so far: ${status.hidden}. If Suggested still shows, open that server, come back here, tap Copy report and paste it to Claude.`),
            btn("Copy report", () => {
                safe(scan);
                const r = report();
                setOut(r);
                const ok = safe(() => {
                    metro.common.clipboard.setString(r);
                    return true;
                }, false);
                toast(ok ? "Report copied - paste it to Claude" : "Screenshot the report below");
            }),
            out ? h(Text, { selectable: true, style: { color: COLORS.sub, fontSize: 11, padding: 16, paddingBottom: 40, fontFamily: "Menlo" } }, out) : null,
        );
    }

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
                    if (js.indexOf(`const VERSION = "${want}"`) === -1) return;
                    P.stopPlugin(id, false);
                    P.startPlugin(id);
                })
                .catch(() => {});
        }, 8000);
    }

    // the suggested section's code may only load when you first open a server, so keep looking
    // for a while (cheap: modules already hidden are skipped)
    let timer = null;
    let stopped = false;
    return {
        onLoad() {
            safe(() => selfRepair("No Suggested"));
            stopped = false;
            let tries = 0;
            const loop = () => {
                if (stopped) return;
                safe(scan);
                if (++tries < 90) timer = setTimeout(loop, tries < 30 ? 2000 : 10000);
            };
            loop();
        },
        onUnload() {
            stopped = true;
            if (timer) clearTimeout(timer);
            unpatches.splice(0).forEach((u) => safe(u));
            patched.length = 0;
            status.hidden = 0;
        },
        settings: Settings,
    };
})()
