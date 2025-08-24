# Repository Guidelines

## Project Structure & Modules
- `src/`: React + TypeScript app (TanStack Start + Vite).
  - `routes/`: File-based routes (`__root.tsx`, `index.tsx`, etc.).
  - `components/`, `hooks/`, `lib/`, `utils/`, `styles/`: UI, state, helpers, and CSS.
- `convex/`: Convex backend functions, schema, and migrations.
- `public/`: Static assets served as-is.
- `docs/`: Project docs and reference material.
- Config: `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `.env.example`.

## Build, Test, and Development
- `pnpm dev`: Run app + Convex locally (Vite on port 3000).
- `pnpm dev:cloud`: App + Convex against Convex prod.
- `pnpm dev:prod-db`: App with `VITE_CONVEX_URL` pointing to prod Convex; no local Convex.
- `pnpm build`: Production build (SSR via Nitro/TanStack Start).
- `pnpm start`: Start built server from `.output/`.

Environment: copy `.env.example` to `.env.local` and fill Clerk, Convex, and other keys. For local Convex, run commands above; for cloud, ensure your Convex deployment is configured.

## Coding Style & Naming
- Language: TypeScript, React function components, hooks-first.
- Files: `PascalCase.tsx` for components, `camelCase.ts` for utilities, route files in `src/routes/`.
- Indentation: 2 spaces; keep lines focused and small components preferred.
- Styling: Tailwind CSS (v4). Prefer utility-first; use `clsx`/`tailwind-merge` where needed.
- Routing: Use TanStack Router conventions from `src/router.tsx` and `src/routes/*`.

## Testing Guidelines
- No formal test runner is configured yet. If adding tests:
  - Unit: Vitest + React Testing Library (suggested patterns: `*.test.ts(x)`).
  - E2E: Playwright for core flows (export, layers, P2P session join).
  - Place tests near sources or under `src/__tests__/`.

## Commit & Pull Requests
- Commits: imperative, concise, present tense. Example: `components: improve Konva drag handles`.
- Group related changes; avoid mixing Convex schema and UI refactors in one commit.
- PRs: include summary, linked issues, test plan (commands and steps), screenshots/GIFs for UI, and note any Convex schema/migration changes.

## Security & Configuration
- Never commit secrets; use `.env.local`.
- Convex: changing schema/migrations requires coordination and clear PR notes.
- Authentication: Clerk config must align across app and Convex.
