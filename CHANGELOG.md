# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.8] - 2026-10-25

### Fixed

- The confirming Rename shadow uses priority -1, which outranks the built-in
  row (a numerically lower priority wins). 0.1.7's priority 1 registered but
  lost the election, leaving the built-in Rename as the active row.

## [0.1.7] - 2026-10-25

### Fixed

- The confirming Rename row now registers with a distinct shadowing priority,
  so it replaces the built-in row instead of failing registration. In 0.1.6 the
  same-priority registration aborted the Client half, which also removed the
  plugin's other menu entries until reload.

## [0.1.6] - 2026-10-25

### Changed

- The conversation row's **Rename** row is now provided by the plugin and always
  opens a confirmation dialog: the title is prefilled and saved only after the
  user confirms; Cancel leaves it untouched. It shadows the built-in Rename row
  so the menu keeps a single entry. The built-in rename shortcut still opens the
  native rename dialog.

## [0.1.5] - 2026-10-25

### Added

- **Delete conversation…** next to Archive in the conversation row menu. A
  confirmation dialog states that the stored log is removed permanently and
  that archiving is the recoverable alternative; nothing is deleted until the
  user confirms.
- Deleting detaches the conversation from its workspace, clears archive/pin
  membership, removes the log directory and its projection-cache row, and
  removes the row from connected Clients. Deletion is refused for a
  conversation that is currently open (a live Session holds the log) and for
  subagent child sessions, with a stable error code.
- `POST /delete-session` with `{ sessionId }` for the confirmed deletion.

## [0.1.4] - 2026-10-25

### Added

- **Organize conversations…** in every conversation's row menu. The Host builds
  a dry-run preview of the workspaces it would create or reuse and the
  conversations it would move; nothing changes until the user selects the
  groups and confirms. Grouping uses each conversation's recorded project
  folder, and falls back to an unambiguous title match against project folders
  under catch-all workspaces and the user's GitHub folder. Already grouped,
  ambiguous, and generic locations (home, /tmp) are reported as staying put.
- `POST /organize` with `{ mode: 'plan' }` and `{ mode: 'apply', targets }` for
  computing and applying the selection.

## [0.1.3] - 2026-10-25

### Fixed

- Moving a real conversation no longer leaves DeepSeek delivery markers naming
  the source Session. Copies now rewrite
  `session-log-deepseek/delivery-accepted` markers to the moved Session id, so
  the copied log loads instead of failing with "current-generation delivery
  marker names the wrong Session". Message content that merely mentions the old
  id is preserved untouched.

## [0.1.2] - 2026-10-25

### Changed

- README: added npm version, npm provenance (SLSA v1), release workflow and
  license badges, plus a **Release provenance** section that documents OIDC
  trusted publishing and how to verify an attestation.
- RELEASING.md: recorded the configured GitHub Actions trusted publisher, the
  tokenless OIDC flow, and the `dist.attestations` / `npm audit signatures`
  verification commands.
- Documentation-only release; no runtime or behaviour change.

Published from GitHub Actions by the tag-triggered trusted-publishing workflow;
the npm tarball for this version carries a SLSA
`https://slsa.dev/provenance/v1` attestation.

## [0.1.1] - 2026-10-25

### Changed

- Published from GitHub Actions through npm trusted publishing (OIDC) with a
  SLSA provenance attestation. No runtime or behaviour change; this release
  validates the tag-triggered release workflow.

## [0.1.0] - 2026-10-25

### Added

- **Move to workspace…** in a conversation's sidebar row menu: copies the full
  transcript into a new Session bound to the chosen workspace, archives the
  original in its old workspace, restores its pinned state, and opens the moved
  conversation.
- **New workspace…** inside the move dialog: picks a folder through the composed
  directory picker, registers it as a workspace, and selects it as the target.
- In-place attach when the conversation's recorded directory is already the
  chosen workspace's directory (the session ID is preserved).
- Authenticated same-origin `POST /move-to-workspace` Host endpoint with stable
  failure codes, including a running-work refusal that names what to stop.
- English and Chinese labels, plugin icon, and a format-1 market index.

[Unreleased]: https://github.com/Stijnus/dsh-move-to-workspace/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Stijnus/dsh-move-to-workspace/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Stijnus/dsh-move-to-workspace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Stijnus/dsh-move-to-workspace/releases/tag/v0.1.0
