# Repository Guidelines

## Project Structure & Module Organization

- Electron app with three layers: `src/main` (main process, window/IPC managers), `src/preload` (bridges safe APIs like `projectAPI`/`editorAPI`), and `src/renderer` (React UI split by window, e.g., `windows/welcome` and `windows/editor`). Shared models live in `src/common`.
- Build artifacts output to `out/`. Assets/styles sit under `src/renderer/src/assets`. Node/electron configs are in repo root (`electron.vite.config.ts`, `electron-builder.yml`).

## Build, Test, and Development Commands

- Install: `pnpm install` (uses `pnpm@10`).
- Dev: `pnpm dev` to run electron-vite with live reload.
- Preview: `pnpm start` serves the built preview.
- Build (all platforms typechecked): `pnpm build`. Platform-specific: `pnpm build:mac`, `pnpm build:win`, `pnpm build:linux`, `pnpm build:unpack`.
- Lint/format/typecheck: `pnpm lint`, `pnpm format`, `pnpm typecheck` (or `typecheck:node`, `typecheck:web`).

## Coding Style & Naming Conventions

- TypeScript + React with functional components. Prefer hooks over classes.
- Styling via Tailwind utility classes and shared UI components (`src/renderer/src/components/ui`).
- Keep files/components PascalCase; hooks camelCase; types/interfaces PascalCase.
- Avoid `any`; keep explicit, safe types unless an exceptional boundary demands otherwise (document why).
- Run `pnpm lint` and `pnpm format` before changes; Prettier (spaces, semicolons off) and ESLint configs are provided. Avoid non-ASCII unless required.
- If a file only exports a single function, name the file in camelCase.

## Testing Guidelines

- No formal test suite present. Add targeted tests alongside new logic when feasible; follow `*.test.ts` or `*.spec.ts` naming. For renderer logic, consider React Testing Library; for IPC/utilities, plain vitest (align with Vite ecosystem). Ensure `pnpm typecheck` stays clean.

## Commit & Pull Request Guidelines

- Commit messages: concise imperative (“Add editor IPC payload handling”). Group related file changes.
- Pull requests should include: summary of behavior changes, manual test notes (commands or UX steps), and screenshots/GIFs for UI updates. Link issues when applicable.

## Security & IPC Tips

- Only expose safe APIs via `src/preload`; validate inputs in `src/main/ipc/*`.
- Avoid direct filesystem writes from renderer; route through IPC handlers.
- When sending project data to the editor window, ensure it is queued until `did-finish-load` (see `WindowManager` pattern).
