# dsh-move-to-workspace

[English](./README.md) · [中文](./README.zh-CN.md)

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

## Quick start

```sh
dsh plugin --profile web add dsh-move-to-workspace
```

Restart the Harness (or refresh the Web UI). Each conversation's **…** menu gains **Move to workspace…**.

<sub>More from this suite: [Moodboard](https://github.com/Stijnus/dsh-moodboard) · [Composer Predictions](https://github.com/Stijnus/dsh-composer-predictions) · [Move to Workspace](https://github.com/Stijnus/dsh-move-to-workspace) · [Workspace Status](https://github.com/Stijnus/dsh-workspace-status) · [Prompt Rewrite](https://github.com/Stijnus/dsh-prompt-optimizer)</sub>

<sub>⭐ If this saves you a step, a star helps the next DSH user find it.</sub>

## What the move does

DSH binds a conversation to a workspace through the directory the conversation
started in: `Workspace.attachSession` validates the Session header's `cwd`
against the workspace path, and persisted session logs are append-only. An
existing conversation therefore cannot be re-pointed at a folder in place.

This plugin performs the supported equivalent:

1. checks for running turns, subagents, background jobs and scheduled tasks,
2. copies the complete event log into a new Session and flushes it durably,
3. attaches the copy to the target workspace and checks that the source transcript has not changed,
4. archives the original, restores its pin on the copy and announces the new Session.

Copy or attachment failures leave the original visible. If the source changes or starts work during copying, archival is refused; an already attached copy remains available alongside the original.

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

## Rename a conversation

The row menu's **Rename** row is provided by the plugin and opens a confirmation
dialog with the current title prefilled. The new title is saved only after you
confirm; Cancel leaves it untouched. An empty title is refused, and a successful
rename updates the sidebar row immediately.

## Delete a conversation

The row menu's **Delete conversation…** sits next to Archive and permanently
removes the stored session log. It always asks first: the confirmation names the
conversation, warns that the deletion cannot be undone, and points at Archive as
the recoverable alternative.

On confirmation the Host detaches the conversation from its workspace, clears
its archive and pin membership, deletes the log directory and its
projection-cache row, and removes the row from connected Clients. Deletion is
refused with a stable error code while the conversation is currently open (a
live Session holds the log) and for subagent child sessions. There is no undo,
and unlike Archive the history is gone for good.

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

Applying uses the same copy-attach-archive operation as **Move to workspace…**,
so moved conversations keep their history and title, and the originals are
archived in their previous workspace.

## Files

| File | Role |
| --- | --- |
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the browser half (`dsh.client`). |
| `cordis.patch.yml` | Inserts the Host row `move-to-workspace`. |
| `index.js` | Host half: the `POST /move-to-workspace` endpoint, the copy/attach/archive operation, and the Session announcement. |
| `client.js` | Browser half: the session row action, the workspace picker dialog, and its create-a-workspace row. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title/description. |
| `test/` | Node test-runner checks for the Host contract, the endpoint guards, and the Client registrations. |
| `scripts/registry-doctor.mjs` | Reports and repairs a workspace registry left with duplicate folder rows or conversations owned twice (§ [Repairing a broken registry](#repairing-a-broken-registry)). |
| `market-index.json` | Format-1 market index for Discover; `versions` is filled after the first npm publication. |

## Endpoints

All endpoints are same-origin and require the owner session; failures answer
`{"ok": false, "code": "...", "message": "..."}`.

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /move-to-workspace` | `{ sessionId, workspaceId }` | `{ ok, sessionId, workspaceId, copied }`; running work refusals include `activity` entries (`turn`, `subagent`, `job`, `schedule`). |
| `POST /organize` | `{ mode: "plan" }` | `{ ok, plan }` — workspace groups marked `create`/`reuse`, per-conversation `move`/`attach`, and the counts of conversations that stay put. |
| `POST /organize` | `{ mode: "apply", targets: [{ path, sessionIds }] }` | `{ ok, workspaces, sessions }` with per-workspace and per-conversation results. |
| `POST /delete-session` | `{ sessionId }` | `{ ok, sessionId, removedLog, logDirectory }`; refuses live Sessions and subagent children. |


## Repairing a broken registry

**0.1.10 fixes this.** Versions 0.1.4–0.1.9 could register a second workspace
for a folder that was already registered under another path spelling (a symlink
next to its target), and the new row adopted the folder's conversations. One
conversation owned by two workspaces makes the stored registry inconsistent, and
`@deepseek-ai/dsh-workspace` refuses to load that state — the app then shows no
workspaces and no conversations at all, with no error on screen.

Conversations are still on disk. Quit the app (the Host rewrites the registry
while it runs) and run:

```sh
node scripts/registry-doctor.mjs          # report only
node scripts/registry-doctor.mjs --fix    # repair, after writing a backup
```

It collapses folders registered more than once onto the row registered under the
resolved path, and leaves each conversation with exactly one owning workspace. It
touches nothing else: no conversation log, projection cache, archive or pin state
is changed. Reopen the app afterwards. The same check runs on demand:
`npm run registry-doctor`.

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
