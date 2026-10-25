# Releasing

Releases start by pushing a `v*` tag; `.github/workflows/release.yml` tests the
commit and publishes it to npm with a provenance attestation. The workflow does
not create the GitHub release or update the market index — finish the checklist
below after npm confirms the version.

## One-time setup

1. Create the GitHub repository and push `main` (the workflows are committed).
2. Configure npm **trusted publishing** for this package: open
   <https://www.npmjs.com/package/dsh-move-to-workspace> → **Settings** →
   **Trusted publishing** → add a GitHub Actions publisher with
   organization/user `Stijnus`, repository `dsh-move-to-workspace`, workflow
   filename `release.yml`, and direct `npm publish` allowed. No npm token is
   stored in GitHub, and the first publication must happen within two days of
   creating the configuration.
3. Optionally protect `main` with the `test` workflow as a required check.

## Cut a release

```bash
# 1. Version and changelog
npm version patch --no-git-tag-version   # or minor / major
#   move the [Unreleased] entries in CHANGELOG.md under the new version

# 2. Ship it
release_version="$(node -p "require('./package.json').version")"
git add -A
git commit -m "${release_version}: <summary>"
git tag -a "v${release_version}" -m "${release_version}"
git push origin main
git push origin "v${release_version}"
```

The tag push checks that the tag matches `package.json`, runs `npm test`, and
publishes with provenance. A version already present in the registry is skipped,
so re-running a tag is safe.

## Market index

`market-index.json` is a format-1 DSH market index that lists this package so a
Discover tab can show it. After npm confirms the new version, set
`plugins[0].versions` to one entry:

```json
{ "version": "<version>", "publishTimestamp": <unix seconds>, "source": { "type": "npm", "registry": "https://registry.npmjs.org/" }, "engines": { "dsh": ">=0.2.1-rc.3 <0.3.0-0" } }
```

```bash
npm view dsh-move-to-workspace time --json   # exact publish time
```

Commit that index update separately so the index never announces a version npm
does not have.
