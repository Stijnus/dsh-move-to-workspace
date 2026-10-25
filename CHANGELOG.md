# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-25

### Changed

- Documentation-only release: adds npm, provenance, release and license badges
  and a Release provenance section to the README, and documents trusted
  publishing plus attestation verification in RELEASING.md. No runtime or
  behaviour change.
- Published through the GitHub Actions trusted-publishing workflow with a SLSA
  provenance attestation, confirming the release path after the docs update.

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
