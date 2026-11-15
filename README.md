# Daynote

A small personal notes app with a Rust serverless API, a static browser UI, and Neon Postgres storage. Notes are sticky notes on a board that fills the browser tab: drag each one anywhere, and it stays where you left it.

## Features

- Create an account with a username and password, then sign in and out.
- Change your username and password from Account settings.
- Add a sticky note with **New note** or by double-clicking an empty spot on the board.
- Drag notes by their header or footer; positions and stacking order are saved.
- Give each note a title (double-click it to rename) and one of six colors.
- Check notes off, and optionally set or change a deadline; overdue deadlines are highlighted. Checking a note off also ticks every checklist line in it.
- Collapse a note to just its title bar and deadline, and resize a note from its bottom-right corner. New notes start at the default size.
- Format note content with **bold** (Ctrl+B), *italic* (Ctrl+I), and checklist lines that each have their own checkbox (Ctrl+Enter ticks the current line). Content is stored as light markdown: `- [ ] ` / `- [x] ` lines, `**bold**`, `*italic*`, with `\` escaping literal `*`.
- Delete notes after a confirmation. Deletion is permanent and cannot be undone.
- Passwords are hashed with Argon2id. Sessions use random HttpOnly, Secure, SameSite cookies; only a SHA-256 digest of each session token is stored in Postgres.
- Each account can only access its own notes.

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

## API

- `GET /api/auth` — current signed-in account.
- `POST /api/auth` — JSON `{ "action": "signup" | "signin", "username": "…", "password": "…" }`. Add `"return_token": true` to get `{ "username": "…", "token": "…" }` instead of a session cookie.
- `PATCH /api/auth` — update credentials with `{ "username": "…", "current_password": "…", "new_password": "…" }`; `new_password` is optional.
- `DELETE /api/auth` — sign out and revoke the session.
- `GET /api/notes` — list the current user’s notes.
- `POST /api/notes` — JSON `{ "title": "…", "content": "…", "color": "yellow", "pos_x": 40, "pos_y": 32, "due_date": "2026-12-31" }`; every field is optional.
- `PATCH /api/notes` — JSON `{ "id": "…" }` plus any of `title`, `content`, `color`, `completed`, `due_date` (empty string clears it), `pos_x`, `pos_y`, `z_index`, `collapsed`, `width`, `height`.
- `DELETE /api/notes` — JSON `{ "id": "…" }`.
- `GET /api/comments` — list comments on the current user’s notes. The board UI no longer shows comments; the API and existing data are kept.
- `POST /api/comments` — JSON `{ "note_id": "…", "content": "…" }`.
- `PATCH /api/comments` — JSON `{ "id": "…", "content": "…" }`.
- `DELETE /api/comments` — JSON `{ "id": "…" }`.

Every endpoint accepts the session either as the `note_session` cookie (web app) or as an `Authorization: Bearer <token>` header (browser extension, desktop app); the header wins when both are sent.

An IP that sends more than 5 requests in one second is blocked for 24 hours. If it does so again after that block ends, it is blocked permanently.

Usernames are 3–24 ASCII letters, numbers, underscores, or hyphens. Passwords must be 8–128 characters. Note titles are limited to 120 characters and note content to 2,000 characters. Colors are `yellow`, `pink`, `blue`, `green`, `purple`, or `orange`; positions are pixels from 0 to 100,000; note widths are 180–1,200 pixels and heights 120–1,200 pixels.
