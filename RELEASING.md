# Releasing

Releases start by pushing a `v*` tag; `.github/workflows/release.yml` tests the
commit and publishes it to npm with a provenance attestation. The workflow does
not create the GitHub release or update the market index — finish the checklist
below after npm confirms the version.

## Trusted publishing (configured)

Configured on 2026-10-25 for this package:

- Provider: GitHub Actions
- Repository: `Stijnus/dsh-move-to-workspace`
- Workflow filename: `release.yml`
- Allowed actions: `npm publish` and `npm stage publish`
- Environment: none

The workflow authenticates with OIDC, so no npm token is stored in GitHub.
Because it runs `npm publish --provenance`, every version published this way
carries a SLSA provenance attestation (`https://slsa.dev/provenance/v1`).
Verify a release with `npm view dsh-move-to-workspace@<version>
dist.attestations` or, after installing it, `npm audit signatures`; the
registry serves the same attestations at
`https://registry.npmjs.org/-/npm/v1/attestations/dsh-move-to-workspace@<version>`.
The 0.1.1 release validated this path end to end.
To inspect or change the configuration, open
<https://www.npmjs.com/package/dsh-move-to-workspace/settings> while signed in
with two-factor authentication. The CLI equivalent (`npm trust list`) also
requires an interactive web 2FA approval per call and exits `EOTP` outside a
terminal.

If the configuration is ever revoked, re-add it with either that settings page
or, from a terminal with an authenticated npm login:

```sh
npm trust github dsh-move-to-workspace \
  --repo Stijnus/dsh-move-to-workspace \
  --file release.yml \
  --allow-publish
```

Optionally protect `main` with the `test` workflow as a required check.

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
