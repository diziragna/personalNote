# Daynote

A small personal notes app with a Rust serverless API, a static browser UI, and Neon Postgres storage. Notes are individual timestamped lines, grouped by their creation date. Each line can be checked off and restored.

## Features

- Create an account with a username and password, then sign in and out.
- Change your username and password from Account settings.
- Add, complete, restore, and delete notes.
- Add multiple timestamped comments to each note.
- Optionally set or change a deadline date for notes and comments.
- View notes grouped by date with their creation times.
- Passwords are hashed with Argon2id. Sessions use random HttpOnly, Secure, SameSite cookies; only a SHA-256 digest of each session token is stored in Postgres.
- Each account can only access its own notes.

## Set up Neon

1. Create a Neon project and copy its pooled connection string.
2. Run [`migrations/0001_init.sql`](migrations/0001_init.sql), [`migrations/0002_abuse_controls.sql`](migrations/0002_abuse_controls.sql), and [`migrations/0003_deadlines.sql`](migrations/0003_deadlines.sql) in order against the Neon database using the Neon SQL Editor or `psql`.
3. Set `DATABASE_URL` to the connection string. Keep `sslmode=require` enabled.

## Run and deploy

The Vercel Rust runtime is in beta. Import this repository as a Vercel project, keep the project root as the repository root, and set `DATABASE_URL` in the project's Environment Variables for each deployment environment. Vercel serves the static app from `public/` and compiles the functions in `api/` using `Cargo.toml`.

For a database-free local preview, run `npm install` once and `npm run dev`, then open `http://127.0.0.1:4173`. On localhost the app stores a demo account, notes, and comments in this browser only, so you can try signup, sign-in, credential changes, date grouping, checkboxes, comments, and deletion without Neon. This preview mode is only enabled on localhost; deployed domains use the Rust API and Neon.

To test the Rust API against Neon before deploying, install the Vercel CLI, copy `.env.example` to `.env.local`, set `DATABASE_URL`, apply the migration, and run `vercel dev`. `.env.local` is ignored by Git.

## API

- `GET /api/auth` — current signed-in account.
- `POST /api/auth` — JSON `{ "action": "signup" | "signin", "username": "…", "password": "…" }`.
- `PATCH /api/auth` — update credentials with `{ "username": "…", "current_password": "…", "new_password": "…" }`; `new_password` is optional.
- `DELETE /api/auth` — sign out and revoke the session.
- `GET /api/notes` — list the current user’s notes.
- `POST /api/notes` — JSON `{ "content": "…" }`.
- `PATCH /api/notes` — JSON `{ "id": "…", "completed": true }` or `{ "id": "…", "content": "…" }`.
- `DELETE /api/notes` — JSON `{ "id": "…" }`.
- `GET /api/comments` — list comments on the current user’s notes.
- `POST /api/comments` — JSON `{ "note_id": "…", "content": "…" }`.
- `PATCH /api/comments` — JSON `{ "id": "…", "content": "…" }`.
- `DELETE /api/comments` — JSON `{ "id": "…" }`.

Usernames are 3–24 ASCII letters, numbers, underscores, or hyphens. Passwords must be 8–128 characters. Notes are limited to 2,000 characters.
