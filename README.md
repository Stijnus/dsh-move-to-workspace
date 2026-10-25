# dsh-move-to-workspace

[![npm version](https://img.shields.io/npm/v/dsh-move-to-workspace?label=npm&color=blue)](https://www.npmjs.com/package/dsh-move-to-workspace)
[![npm provenance](https://img.shields.io/badge/npm%20provenance-SLSA%20v1-brightgreen)](https://www.npmjs.com/package/dsh-move-to-workspace)
[![release](https://github.com/Stijnus/dsh-move-to-workspace/actions/workflows/release.yml/badge.svg)](https://github.com/Stijnus/dsh-move-to-workspace/actions/workflows/release.yml)
[![license](https://img.shields.io/npm/l/dsh-move-to-workspace)](LICENSE)

Move an existing DeepSeek Harness conversation into another workspace from the
sidebar.

Open a conversation's **…** menu and choose **Move to workspace…**, then pick a
target workspace — or register a new folder from the same dialog with
**New workspace…** — and confirm. The conversation appears under the target
workspace with its full history and title, continues there, and the original is
archived in its old workspace (restorable with **Unarchive**).

## What the move does

DSH binds a conversation to a workspace through the directory the conversation
started in: `Workspace.attachSession` validates the Session header's `cwd`
against the workspace path, and persisted session logs are append-only. An
existing conversation therefore cannot be re-pointed at a folder in place.

This plugin performs the supported equivalent:

1. archives the original conversation (the Host's activity check refuses the
   move while a turn, subagent, background job, or scheduled task still runs),
2. copies the complete event log into a new Session whose header records the
   target workspace directory,
3. attaches that new Session to the target workspace, rebuilds its projection
   checkpoint so the sidebar row carries the title immediately, restores the
   original's pinned state, and opens it,
4. announces the new Session so connected Clients show the row at once.

When the conversation's recorded directory already *is* the target workspace
directory (for example an ungrouped conversation that ran there), the plugin
attaches the existing Session instead of copying it, so the ID is preserved.

### Consequences

- The moved conversation has a **new session ID**. Links, running jobs, and
  scheduled tasks referencing the old ID stay with the archived original.
- The original log stays on disk (archived, hidden by the default filter). It
  is not deleted; DSH has no session-deletion primitive.
- The archived original keeps its position under the old workspace, so
  unarchiving returns it there rather than to the target.
- Copies made with this plugin are ordinary Sessions: no fork marker and no
  invented parent link for a top-level conversation.

## Choosing the target

The dialog lists every workspace except the one that currently owns the
conversation. **New workspace…** opens the composed directory picker (the
native macOS/Windows folder chooser in Desktop), registers the chosen directory
as a workspace, and selects it as the target. If the chosen directory is
already this conversation's workspace, the dialog says so instead of moving.

## Install

From the plugin market / a profile:

```sh
dsh plugin --profile <profile> add dsh-move-to-workspace
```

Or, from a local checkout, install the directory as a bundle: sidebar →
**Plugins** → **Add plugin** → the absolute path to this directory →

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-move-to-workspace
```

A new browser half may need a page reload (⌘R) to appear. Remove it with
`dsh plugin --profile <profile> remove dsh-move-to-workspace`.

## Release provenance

Releases are built and published by GitHub Actions through npm **trusted
publishing** (OIDC): the workflow exchanges a short-lived GitHub OIDC token for
npm publish rights, so no npm token or secret is stored in the repository or in
GitHub. Every published version carries a SLSA provenance attestation
(`https://slsa.dev/provenance/v1`).

Verify the latest release:

```sh
npm view dsh-move-to-workspace@latest dist.attestations
npm audit signatures   # inside a project that installed the package
```

The attestation is visible on the
[npm package page](https://www.npmjs.com/package/dsh-move-to-workspace) and
served by the registry at
`https://registry.npmjs.org/-/npm/v1/attestations/dsh-move-to-workspace@<version>`.
The publishing workflow is
[`.github/workflows/release.yml`](.github/workflows/release.yml); the publisher
configuration and release steps are in [RELEASING.md](RELEASING.md).

## Organize conversations

Choose **Organize conversations…** from any conversation's row menu. The plugin
builds a dry-run plan for every current (non-archived, non-subagent)
conversation:

- a conversation whose recorded folder is a project folder is grouped into a
  workspace at that folder — reused when one is registered, created when not;
- a conversation that started in a catch-all workspace (such as the default
  workspace, which contains other workspaces) is matched by an unambiguous
  title/folder-name match against project folders under that workspace and
  under `~/Developer/GitHub`.

The preview lists each workspace group with **CREATE** or **REUSE**, its path,
the conversations it would receive, and whether each conversation is moved
(copied, new session id) or attached in place (same folder, same id). Deselect
any group before confirming; **nothing changes until you press Organize**.
Conversations that are already correctly grouped, ambiguous matches, and
generic locations like home or `/tmp` are counted as staying put rather than
guessed.

Applying uses the same archive-copy-attach operation as **Move to workspace…**,
so moved conversations keep their history and title, and the originals are
archived in their previous workspace.

## Files

| File | Role |
| --- | --- |
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the browser half (`dsh.client`). |
| `cordis.patch.yml` | Inserts the Host row `move-to-workspace`. |
| `index.js` | Host half: the `POST /move-to-workspace` endpoint, the archive/copy/attach operation, and the Session announcement. |
| `client.js` | Browser half: the session row action, the workspace picker dialog, and its create-a-workspace row. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title/description. |
| `test/` | Node test-runner checks for the Host contract, the endpoint guards, and the Client registrations. |
| `market-index.json` | Format-1 market index for Discover; `versions` is filled after the first npm publication. |

## Endpoint

`POST /move-to-workspace` (same origin, owner session) with
`{"sessionId": "...", "workspaceId": "..."}`. Success:
`{"ok": true, "sessionId": "<moved>", "workspaceId": "...", "copied": true|false}`.
Failures: `{"ok": false, "code": "...", "message": "..."}`. Refusals while work
runs include `activity` entries (`turn`, `subagent`, `job`, `schedule`) so the
dialog can name what to stop.

## Limits

- Refuses archived conversations, subagent conversations, blank conversations,
  and conversations with no recorded directory.
- The move needs the target workspace directory to exist. **New workspace…**
  needs a composed directory picker; without one the dialog reports that
  workspaces cannot be created from it.
- The copy runs in-process on the Host thread; very large transcripts make the
  request proportionally longer.

## Development

```sh
npm test
npm pack --dry-run
```

## License

MIT
