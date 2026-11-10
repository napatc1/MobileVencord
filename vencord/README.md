# Ping Box + Read As You Go for Vencord (desktop)

Vencord can't install plugins from a link. Custom plugins go in Vencord's `src/userplugins` folder
and you build Vencord once from source.

1. Install **Git**, **Node.js** (LTS) and **pnpm** (`npm i -g pnpm`).
2. Get Vencord's source and its dependencies:
   ```
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
3. Copy the two folders `pingBox` and `readAsYouGo` into `Vencord/src/userplugins/`
   (create `userplugins` if it doesn't exist).
4. Build and install into Discord:
   ```
   pnpm build
   pnpm inject
   ```
   (`pnpm inject` asks which Discord install to patch. Fully quit Discord first.)
5. Open Discord → Settings → Vencord → Plugins, turn on **PingBox** and **ReadAsYouGo**.

After updating these files, run `pnpm build` again and restart Discord.

## Ping Box
An @ button in the message bar (with a red count) appears when you were pinged in the current server.
Click it for the list of pinged channels (any category). Click a channel to jump straight to the ping:
the oldest unread message that pings you by name, @everyone/@here or a role you have.

## Read As You Go
As you scroll, it marks the channel read up to the newest message that's actually been on your screen
(default: 60% visible, 0.8 s after you stop scrolling). It never marks anything you haven't seen, never
moves your read point backwards, and does nothing while the Discord window isn't focused.
Both values are adjustable in the plugin's settings.
