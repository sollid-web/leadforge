# Development guide

This project is a Next.js application with a Supabase-backed runtime and a demo-safe fallback mode.

## Prerequisites

- Node.js 20+
- pnpm 11+
- Supabase project access (optional for demo mode)
- browser for local validation

## Local setup

```bash
git clone https://github.com/sollid-web/leadforge.git
cd leadforge
pnpm install
cp .env.example .env.local
pnpm dev
```

## Demo mode

If environment variables are absent, the app runs in demo mode and presents safe sample data while reporting a demo status in the API.

## Live mode

Add your Supabase credentials in `.env.local` and apply the SQL migrations before enabling live auth and lead writes.

## Verification

Run these commands before submitting significant changes:

```bash
pnpm lint
pnpm build
```
