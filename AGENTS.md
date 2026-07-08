# Repository Guidelines

## Project Structure & Module Organization

- Tauri v2 app with two layers: `src-tauri/` (Rust backend: commands, custom protocol, window management) and `src/` (React frontend).
- Frontend is a multi-window Vite app with three entry points under `src/windows/`: `main/` (welcome page + settings), `editor/`, and `player/`.
- Shared code lives in `src/components/` (UI), `src/hooks/`, `src/providers/`, `src/lib/`, and `src/types/`.
- Rust commands in `src-tauri/src/commands/` replace Electron IPC: `project.rs` (CRUD), `settings.rs` (app config), `window.rs` (multi-window management).
- `mss://` custom URI protocol in `src-tauri/src/protocol.rs` serves local files to the webview.
- Settings stored in system app data dir; project data stored in user-selected workspace directory.

## Build, Test, and Development Commands

- Install: `pnpm install` (uses `pnpm@10`).
- Dev: `pnpm tauri dev` to run Tauri with Vite HMR.
- Build: `pnpm tauri build` for production.
- Frontend only: `pnpm dev` (Vite), `pnpm build` (Vite build).
- Lint/format/typecheck: `pnpm lint`, `pnpm format`, `pnpm typecheck`.
- Rust check: `cd src-tauri && cargo check`.

## Coding Style & Naming Conventions

- TypeScript + React with functional components. Prefer hooks over classes.
- Styling via Tailwind utility classes and shared UI components (`src/components/ui`).
- Keep files/components PascalCase; hooks camelCase; types/interfaces PascalCase.
- Avoid `any`; keep explicit, safe types unless an exceptional boundary demands otherwise (document why).
- All variables and function/method return values must have explicit type annotations; do not rely on inference at implementation boundaries. When touching legacy code, bring the touched scope into compliance.
- Run `pnpm lint` and `pnpm format` before changes; Prettier (spaces, semicolons off) and ESLint configs are provided.
- If a file only exports a single function, name the file in camelCase.
- Frontend communicates with backend via `invoke()` from `@tauri-apps/api/core`.
- Inter-window communication uses Tauri event system (`emit`/`listen`).

## Testing Guidelines

- No formal test suite present. Add targeted tests alongside new logic when feasible; follow `*.test.ts` or `*.spec.ts` naming. For renderer logic, consider React Testing Library; for Rust commands, use `#[cfg(test)]` modules. Ensure `pnpm typecheck` and `cargo check` stay clean.

## Commit & Pull Request Guidelines

- Commit messages: concise imperative ("Add editor IPC payload handling"). Group related file changes.
- Pull requests should include: summary of behavior changes, manual test notes (commands or UX steps), and screenshots/GIFs for UI updates. Link issues when applicable.

## Security Tips

- Validate inputs in Rust commands before filesystem operations.
- Use Tauri capabilities to restrict permissions per window.
- The `mss://` protocol serves arbitrary local files — only use for user-selected project assets.
