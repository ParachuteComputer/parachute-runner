# Releasing `@openparachute/runner`

Releases are automated via [`.github/workflows/release.yml`](./.github/workflows/release.yml). Pushing a git tag triggers CI which:

1. Runs `bun run typecheck` + `bun test src/`
2. Publishes to npm (with provenance attestation, via Trusted Publishing OIDC)

Runner has no container image artifact — npm publish is the only release surface.

## Tag conventions

Per [parachute-patterns governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md):

| Tag shape | Example | npm `dist-tag` |
|---|---|---|
| `vX.Y.Z-rc.N` | `v0.1.0-rc.8` | `rc` |
| `vX.Y.Z` | `v0.1.0` | `latest` |

The workflow auto-detects rc vs stable from the tag string (`-rc.` substring).

## Release flow

### For an rc bump (each code-touching PR merge)

After your PR merges to `main` with a bumped `rc.N`:

```sh
git fetch && git checkout main && git pull --ff-only
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-runner/actions).

### Promoting an rc chain to stable

When the rc chain is ready to release:

1. Open a PR that drops the `-rc.N` suffix from `package.json` (e.g. `0.1.0-rc.8` → `0.1.0`).
2. Reviewer + merge as usual.
3. Tag the merged commit with the bare version: `git tag v0.1.0 && git push origin v0.1.0`.
4. CI publishes with `dist-tag=latest`.

### Doc-only PRs

Per governance, doc-only PRs are EXEMPT from rc.N bumping — they merge without a version bump and get picked up by the next code-touching PR's rc bump (or by the stable promotion, whichever comes first). Don't fragment a release into many patch bumps mid-validation.

If you DO need to ship a doc-only fix outside an active rc chain (i.e. main is on a stable version with no rc.N in flight), bump the next patch (`0.1.0` → `0.1.1`), tag, ship.

## One-time setup (operator)

Before the workflow can publish, this repo needs:

1. **npm Trusted Publisher**: log into npmjs.com → package `@openparachute/runner` → Settings → Trusted Publishers → "Add a new publisher" → choose **GitHub Actions**. Fill:
   - Organization: `ParachuteComputer`
   - Repository name: `parachute-runner`
   - Workflow filename: `release.yml`
   - Environment name: (leave blank)

   No `NPM_TOKEN` secret needed — the workflow uses OIDC.

## Verifying a release

```sh
npm view @openparachute/runner@<version> dist.tarball
npm view @openparachute/runner dist-tags
```

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path for npm (strict 72-hour unpublish policy that you should avoid for published packages anyway). To roll back: cut a new patch from a known-good commit (e.g. `0.1.0` → `0.1.1` reverting the bad change).

## Troubleshooting

- **Workflow doesn't trigger**: confirm the tag matches the workflow's `on.push.tags` pattern (`v[0-9]+.[0-9]+.[0-9]+` or `v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`).
- **`version mismatch` error in publish-npm**: package.json version differs from the tag. Re-tag the correct commit.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are exactly `ParachuteComputer` / `parachute-runner` / `release.yml`. If the workflow file was renamed, the rule needs updating on npm.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level. Verify the YAML.
