# Kiln

Kiln is a local desktop companion to vdrs-website. It prepares archival 3D masters for public web viewing. Keep originals intact and all processing on the user's machine.

- Use `pnpm agent --help` for desktop smoke checks, environment inspection, and asset pipeline verification.
- Run `pnpm check`, `pnpm lint`, `pnpm format:check`, and relevant logic tests. Exercise changes in the actual Electron app.
- Renderer and visual work belongs to the latest Claude Opus. Engine correctness and host integration belong to Codex. Follow `DESIGN.md` once written.
- Never commit source scans, personal asset paths, optimization outputs, or screenshots containing private data. `artifacts/`, `release/`, `.cache/`, and 3D binary files stay local.
- Keep the desktop bridge typed in `shared/contracts.ts`. Engine work runs off the renderer thread. Preserve material roles and normal-map vector handling.
- No em dashes in product copy. Avoid continuously running animations or render loops; render on interaction and state changes.
