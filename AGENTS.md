# Repository Guidelines

## Project Structure & Module Organization

- Tauri v2 app with two layers: `src-tauri/` (Rust backend: commands, custom protocol, window management) and `src/` (React frontend).
- Frontend is a multi-window Vite app with three entry points under `src/windows/`: `main/` (welcome page + settings), `editor/`, and `player/`.
- On mobile (Android first), `main` becomes a single-webview AppShell and navigates to `#/editor/:project` / `#/player/:project` instead of opening extra windows.
- Responsive helpers: `src/lib/platform.ts`, `src/hooks/useViewportMode.ts` (`phone` <768, `tablet` 768–1023, `desktop` ≥1024).
- Shared code lives in `src/components/` (UI), `src/hooks/`, `src/providers/`, `src/lib/`, and `src/types/`.
- Rust commands in `src-tauri/src/commands/` replace Electron IPC: `project.rs` (CRUD), `settings.rs` (app config), `window.rs` (multi-window management; mobile no-ops).
- Desktop-only plugins (e.g. global-shortcut) are cfg-gated; capabilities split desktop extras into `capabilities/desktop.json`.
- `mss://` custom URI protocol in `src-tauri/src/protocol.rs` serves local files to the webview.
- Settings stored in system app data dir; desktop project data uses user-selected workspace; Android defaults to app private storage.

## Build, Test, and Development Commands

- Install: `pnpm install` (uses `pnpm@10`).
- Dev: `pnpm tauri dev` to run Tauri with Vite HMR.
- Build: `pnpm tauri build` for production.
- Android: `pnpm android:dev`, `pnpm android:build` (init with `pnpm android:init` if needed).
- Frontend only: `pnpm dev` (Vite), `pnpm build` (Vite build).
- Lint/format/typecheck: `pnpm lint`, `pnpm format`, `pnpm typecheck`.
- Rust check: `cd src-tauri && cargo check`.

## Release Versioning

- For prereleases, update `package.json`, `src-tauri/Cargo.toml`, and the root package entry in `src-tauri/Cargo.lock`, then publish the matching `v*` tag.
- Do not add `alpha`, `beta`, or `rc` identifiers to `src-tauri/tauri.conf.json`. Windows MSI packaging only accepts a numeric prerelease identifier and rejects versions such as `1.0.0-beta.2`. Keep the Tauri bundle version at the corresponding stable core version (for example, `1.0.0`) and express prerelease status through the package/Cargo versions and Git tag.

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

## Internationalization

- All user-facing frontend text must use the shared i18n system; do not add hard-coded UI strings in components, dialogs, notifications, accessibility labels, empty states, error messages, or onboarding steps.
- Keep `en`, `ja`, `zh-CN`, and `zh-HK` locale resources in sync whenever adding or changing a translation key. Do not rely on another locale as a permanent fallback.
- Use locale-aware helpers for generated labels and runtime summaries, including snippet descriptions, asset kinds, save/playback states, and legacy-data fallbacks.
- Treat onboarding as part of the product UI: every tour title, description, action, skip label, and interactive prompt must be translated in all supported locales.
- Preserve proper names, credited biographies, and user-authored project content unless a product requirement explicitly calls for translating them.
- Before finishing frontend work, search the touched UI for newly introduced hard-coded user-facing text and run `pnpm typecheck` to catch missing or structurally inconsistent locale keys.

## Cross-Platform Compatibility

- Treat runtime platform, input mode, and viewport size as separate concerns. Desktop builds on macOS, Linux, and Windows must retain desktop navigation/layout regardless of window width; Android/iOS may use responsive phone/tablet layouts and single-webview navigation.
- Never assume filesystem paths, URL serialization, window creation, fullscreen, orientation, or file pickers behave identically across platforms. Keep platform-specific behavior behind shared helpers with a safe fallback.
- Preserve `src/lib/projectAssetUrl.ts`'s segment-by-segment encoding and protocol-base resolution. Passing a complete hierarchical path directly to `convertFileSrc` breaks model-relative assets on Windows; keep the regression protection from commit `1c387fe2` intact.
- Keep dynamic Tauri window commands asynchronous. Creating WebView2 windows from synchronous commands can deadlock Windows' COM message pump.
- On Android/iOS, handle file-picker `content://`-style sources as opaque inputs rather than assuming ordinary filesystem paths. Native-only APIs and plugins must be platform-gated and must not break desktop builds.
- Generated Tauri capability/schema output can vary by the platform that ran the CLI. Do not commit large generated-schema churn unless the source capabilities actually changed and the generated output is intentionally synchronized.
- Before finishing platform-sensitive changes, verify the shared frontend (`pnpm typecheck`, lint/build as appropriate), Rust desktop code (`cargo check`), and the affected native target (for example an Android Gradle compile task). Document any target that could not be checked locally.

## Testing Guidelines

- No formal test suite present. Add targeted tests alongside new logic when feasible; follow `*.test.ts` or `*.spec.ts` naming. For renderer logic, consider React Testing Library; for Rust commands, use `#[cfg(test)]` modules. Ensure `pnpm typecheck` and `cargo check` stay clean.

## Commit & Pull Request Guidelines

- Commit messages: concise imperative ("Add editor IPC payload handling"). Group related file changes.
- Pull requests should include: summary of behavior changes, manual test notes (commands or UX steps), and screenshots/GIFs for UI updates. Link issues when applicable.

## Security Tips

- Validate inputs in Rust commands before filesystem operations.
- Use Tauri capabilities to restrict permissions per window.
- The `mss://` protocol serves arbitrary local files — only use for user-selected project assets.
