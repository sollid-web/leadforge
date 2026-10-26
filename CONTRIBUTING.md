# Contributing

Thanks for helping improve EstatelQ. Contributions should preserve the product's privacy gates and keep implementation claims accurate.

## Development

1. Install Node.js 20+ and pnpm 11.
2. Follow [`docs/development.md`](./docs/development.md) for local setup and Supabase migrations.
3. Use a development Supabase project and synthetic records. Do not use real owner data in local fixtures or tests.
4. Create a focused branch and make changes limited to the requested product behavior.

## Engineering expectations

- Validate all API input with Zod and authorize each request server-side.
- Keep organization identifiers derived from the authenticated membership or verified source token; never trust a client-supplied tenant ID.
- Preserve RLS and add tests/checklists for tenant boundaries when changing policies.
- Do not include private address, owner contact, or unreviewed source payloads in logs, summaries, or outreach.
- Do not add scraping, owner messaging, or third-party data adapters without verifying the source permission model and privacy safeguards.
- Explain scoring factors and keep rule versions explicit.
- Do not claim an integration or automation is active until it is connected and tested.

## Before opening a pull request

Run the smallest relevant checks, and for application changes run:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

Describe migrations, environment changes, privacy impact, validation performed, and any remaining limitations. Never attach real credentials, source tokens, production data, or decrypted owner details.
