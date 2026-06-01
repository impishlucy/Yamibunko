# Yamibunko WebApp

Next.js App Router WebUI for the local Yamibunko anime library.

## Development

Use Bun with a Node.js 24 runtime available for Next.js server execution.
Create `.env` from `.env.example`, then run:

```bash
bun install
bun run dev
```

The database is created automatically at `.yamibunko/yamibunko.sqlite` inside
the webapp directory.

## Quality Checks

```bash
bun run lint
bun run typecheck
bun run build
```
