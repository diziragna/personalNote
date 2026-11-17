# Daynote

A small personal notes app with a Rust serverless API, a static browser UI, and Neon Postgres storage. Notes are sticky notes on a board that fills the browser tab: drag each one anywhere, and it stays where you left it.

## Features

- Create an account with a username and password, then sign in and out.
- Change your username and password from Account settings, or delete the account there (with your password) to remove it and all its notes permanently.
- Add a sticky note with **New note** or by double-clicking an empty spot on the board.
- Drag notes by their header or footer; positions and stacking order are saved.
- Give each note a title (double-click it to rename) and one of six colors.
- Check notes off, and optionally set or change a deadline; overdue deadlines are highlighted. Checking a note off also ticks every checklist line in it.
- Collapse a note to just its title bar and deadline, and resize a note from its bottom-right corner. New notes start at the default size.
- Format note content with **bold** (Ctrl+B), *italic* (Ctrl+I), and checklist lines that each have their own checkbox (Ctrl+Enter ticks the current line). Content is stored as light markdown: `- [ ] ` / `- [x] ` lines, `**bold**`, `*italic*`, with `\` escaping literal `*`.
- Delete notes after a confirmation. Deletion is permanent and cannot be undone.
- Passwords are hashed with Argon2id. Sessions use random HttpOnly, Secure, SameSite cookies; only a SHA-256 digest of each session token is stored in Postgres.
- Each account can only access its own notes.
- The DM Sans and Manrope fonts are served from [`public/fonts/`](public/fonts/) (SIL Open Font License 1.1), so the board looks the same on the web and in the desktop app, online or offline, and loads nothing from other sites.

## Set up Neon

1. Create a Neon project and copy its pooled connection string.
2. Run [`migrations/0001_init.sql`](migrations/0001_init.sql), [`migrations/0002_abuse_controls.sql`](migrations/0002_abuse_controls.sql), [`migrations/0003_deadlines.sql`](migrations/0003_deadlines.sql), [`migrations/0004_sticky_notes.sql`](migrations/0004_sticky_notes.sql), [`migrations/0005_note_layout.sql`](migrations/0005_note_layout.sql), and [`migrations/0006_temporary_ip_blocks.sql`](migrations/0006_temporary_ip_blocks.sql) in order against the Neon database using the Neon SQL Editor or `psql`.
3. Set `DATABASE_URL` to the connection string. Keep `sslmode=require` enabled.

## Run and deploy

The Vercel Rust runtime is in beta. Import this repository as a Vercel project, keep the project root as the repository root, and set `DATABASE_URL` in the project's Environment Variables for each deployment environment. Vercel serves the static app from `public/` and compiles the functions in `api/` using `Cargo.toml`.

For a database-free local preview, run `npm install` once and `npm run dev`, then open `http://127.0.0.1:4173`. On localhost the app stores a demo account, notes, and comments in this browser only, so you can try signup, sign-in, credential changes, dragging, colors, titles, checkboxes, deadlines, and deletion without Neon. This preview mode is only enabled on localhost; deployed domains use the Rust API and Neon.

To test the Rust API against Neon before deploying, install the Vercel CLI, copy `.env.example` to `.env.local`, set `DATABASE_URL`, apply the migration, and run `vercel dev`. `.env.local` is ignored by Git.

## Browser extension

[`extension/`](extension/) is a popup for Chrome and Firefox (Manifest V3, no build step). It lists your notes collapsed to their title and deadline, sorted with open notes first and the soonest deadline first. Click a note to expand it; opening another closes the first. The search box matches every word against note titles, content, and deadlines (`2026-11`, `Nov 3`, or `overdue`). The popup has no background script, shows the last loaded notes instantly from extension storage, and makes one `GET /api/notes` request each time it opens.

1. The extension talks to `https://personalnote-mu.vercel.app`. To point it at another deployment, change `host_permissions` in [`extension/manifest.json`](extension/manifest.json); the popup reads the API address from there.
2. Chrome: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and choose the `extension` folder.
3. Firefox (128+): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and choose `extension/manifest.json`. A temporary add-on is removed when Firefox restarts; to keep it installed, sign it through addons.mozilla.org (unlisted is fine).

Sign in with your Daynote account. The extension uses its own session token, so signing out of the extension does not sign you out of the web app.

## Desktop app

[`desktop/`](desktop/) is a Tauri 2 app for Windows and Ubuntu, built from the same files in `public/` as the web app, that keeps working offline. It has no board window: like Sticky Notes on Windows, every note is a small frameless window of its own that you can leave anywhere on the screen.

- **Move** a note by dragging its header or footer, and **resize** it from its edges or the bottom-right corner. Where each note sits is remembered on this device only and is never synced; a note's size is part of the note. A note you have not placed yet opens where it sits on the web board.
- **＋** in a note's header makes a new note next to it; **⋮** opens the note's menu (color, rename, deadline, sync, delete).
- The **tray icon** has the rest: **New note**, **Show notes** (bring them all in front of other windows), **Hide notes**, **Sync** (choose **Sync automatically when online** or **Sync only when I ask**, or **Sync now**), **Account…** (the window for signing in and out, dark mode, and account settings), **Start with the system**, and **Quit Daynote**. Notes stay out of the taskbar, so the tray is how you get back to them when other windows cover them.
- Daynote starts with the system and puts your notes back where you left them. The account window only opens by itself when there is no note to show yet, and closing it leaves Daynote running.
- On Ubuntu's Wayland session the app runs through XWayland (it sets `GDK_BACKEND=x11` unless you set it yourself), because Wayland does not let an app place its own windows, so notes could not return to where they were left.

Every note is saved on the device first, in an SQLite file in the app's data folder (`%APPDATA%\app.daynote.desktop` on Windows, `~/.local/share/app.daynote.desktop` on Ubuntu).

- **In cave** on the sign-in screen uses the app without an account: notes are stored only on this device and nothing is sent to the cloud. **Out of cave** in the account menu creates an account or signs in to one; the cave notes come along, marked *Not synced*, and stay on the device until you sync them. Until then the cloud only holds the account.
- **Signed in**, notes are only sent to the cloud when you sync, unless you choose **Sync automatically when online** in the tray's **Sync** menu: then changes go up a few seconds after you make them, and anything made offline goes up once you are back online. Conflicts still wait for you to choose. **Sync this note** in a note's menu syncs one note; **Sync now** in the tray (or **Sync all** in the account window) syncs every note. Each sync also brings the cloud's notes down, and while the app is online it brings cloud changes down on its own (on start, when a note gets focus, and every five minutes, at most once a minute). Notes show *Not synced* (never synced) or *Changed* (edited since the last sync), and the status line counts what is waiting.
- **Offline**, a signed-in account keeps working from the notes on the device; you can sign in again offline with the password from your last online sign-in on this device. Syncing waits until you're back online. If the app restarted while offline, sign out and sign in again online before syncing.
- **Conflicts**: if a note changed both on this device and in the cloud since the last sync, it shows a *Conflict* bar to keep this device's version, keep the cloud's, or keep both as two notes. A note deleted here but changed in the cloud is restored with the cloud's version.
- **Signing out** keeps the account's notes on the device and in the cloud. **Deleting the account** removes it and its notes from the cloud; the notes on this device move back to the cave.

Account changes (sign-up, changing credentials, deleting the account) need a connection. The app talks to `https://personalnote-mu.vercel.app`; set `DAYNOTE_API` to point a build at another deployment.

To run it from source, install Rust, Node.js, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system (WebView2 is already on Windows 10 and 11; Ubuntu needs `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, and `libssl-dev`), then:

```sh
cd desktop
npm install
npm run dev     # run the app
npm run build   # build installers into desktop/src-tauri/target/release/bundle
```

Windows builds produce an `.msi` and an `.exe` installer; Ubuntu builds produce a `.deb` and an AppImage, and must be built on Linux. The [Desktop app workflow](.github/workflows/desktop.yml) builds both on GitHub Actions: run it from the Actions tab, or push a tag like `desktop-v0.1.0`, and download the installers from the run's artifacts. The installers are not code-signed, so Windows SmartScreen warns on first install.

The desktop app checks notes with the same rules as the API ([`src/rules.rs`](src/rules.rs)) and syncs through [`POST /api/sync`](#api), so a full sync is a single request.

## API

- `GET /api/auth` — current signed-in account.
- `POST /api/auth` — JSON `{ "action": "signup" | "signin", "username": "…", "password": "…" }`. Add `"return_token": true` to get `{ "username": "…", "token": "…" }` instead of a session cookie.
- `PATCH /api/auth` — update credentials with `{ "username": "…", "current_password": "…", "new_password": "…" }`; `new_password` is optional.
- `DELETE /api/auth` — sign out and revoke the session. With JSON `{ "delete_account": true, "password": "…" }` it instead deletes the account with all its sessions, notes, and comments; this cannot be undone.
- `GET /api/notes` — list the current user’s notes.
- `POST /api/notes` — JSON `{ "title": "…", "content": "…", "color": "yellow", "pos_x": 40, "pos_y": 32, "due_date": "2026-12-31" }`; every field is optional.
- `PATCH /api/notes` — JSON `{ "id": "…" }` plus any of `title`, `content`, `color`, `completed`, `due_date` (empty string clears it), `pos_x`, `pos_y`, `z_index`, `collapsed`, `width`, `height`.
- `DELETE /api/notes` — JSON `{ "id": "…" }`.
- `GET /api/comments` — list comments on the current user’s notes. The board UI no longer shows comments; the API and existing data are kept.
- `POST /api/comments` — JSON `{ "note_id": "…", "content": "…" }`.
- `PATCH /api/comments` — JSON `{ "id": "…", "content": "…" }`.
- `DELETE /api/comments` — JSON `{ "id": "…" }`.
- `POST /api/sync` — apply notes edited on a device in one request: JSON `{ "changes": [ … ], "pull": true }` with up to 500 changes. Each change is `{ "id": "…", "base_updated_at": "…", "note": { … } }` or `{ "id": "…", "base_updated_at": "…", "deleted": true }`. `id` is a UUID the device chose, `base_updated_at` is the cloud `updated_at` the device last saw (omit it for a note never synced), and `note` is the note's full state with the same fields as `PATCH /api/notes` plus an optional `created_at`. A change only applies while the cloud copy is still at `base_updated_at`. The response has one result per change, `{ "id": "…", "status": "created" | "updated" | "deleted" | "conflict" | "invalid", "note": { … }, "error": "…" }`; a `conflict` carries the current cloud note, or `null` if it was deleted. With `"pull": true` the response also lists every cloud note under `notes`.

Every endpoint accepts the session either as the `note_session` cookie (web app) or as an `Authorization: Bearer <token>` header (browser extension, desktop app); the header wins when both are sent.

An IP that sends more than 5 requests in one second is blocked for 24 hours. If it does so again after that block ends, it is blocked permanently.

Usernames are 3–24 ASCII letters, numbers, underscores, or hyphens. Passwords must be 8–128 characters. Note titles are limited to 120 characters and note content to 2,000 characters. Colors are `yellow`, `pink`, `blue`, `green`, `purple`, or `orange`; positions are pixels from 0 to 100,000; note widths are 180–1,200 pixels and heights 120–1,200 pixels.
