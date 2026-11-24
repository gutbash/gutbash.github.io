# baz.bz

Personal site. One static page built with Vite; the only script is the heart in the tagline (`src/heart.js`).

- `pnpm dev` / `pnpm build` / `pnpm preview`
- `pnpm font` regenerates the Geist subset in `src/` (see `scripts/subset-font.mjs`)

Hosted on Cloudflare Workers static assets (`wrangler.jsonc`). `pnpm deploy` builds and publishes; pushing to GitHub does not deploy.

`pnpm icons` is not wired up: run `python scripts/icons.py public` to regenerate the PNG icons (needs Pillow).
