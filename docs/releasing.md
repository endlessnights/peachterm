# Releasing PeachTerm

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml). It is separate from
CI and runs **only** for an explicit version tag (or a manual dry run). Pushing to `main` never creates a release.

## What the workflow does

1. **Validate** — the tag must look like `vX.Y.Z`, `vX.Y.Z-alpha.N`, `-beta.N` or `-rc.N`, and must equal the
   version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
   `src-tauri/Cargo.lock` (`scripts/check-release-version.mjs`). Anything else fails with a clear message.
2. **Draft** — creates a _draft_ GitHub Release for the tag (release notes with changes, platforms, limitations,
   license). Alpha/beta/rc tags are marked as pre-releases. It refuses to continue if a release for the tag exists.
3. **Build** — builds all targets in parallel with `tauri-apps/tauri-action` and attaches the installers to the draft:

   | Platform            | Files                                               |
   | ------------------- | --------------------------------------------------- |
   | Windows x64         | `PeachTerm_<version>_x64-setup.exe` (NSIS)          |
   | Linux x64           | `PeachTerm_<version>_amd64.deb`, `…_amd64.AppImage` |
   | macOS Apple Silicon | `PeachTerm_<version>_aarch64.dmg`                   |
   | macOS Intel         | `PeachTerm_<version>_x64.dmg`                       |

4. **Publish** — only if every build job succeeded **and** all five files are attached, the draft is published.
   Otherwise it stays a draft and nothing is public.

Permissions: the workflow has `contents: read` by default; only the draft, build and publish jobs get
`contents: write`. It never runs for pull requests, so release credentials are not exposed to untrusted code.
There is no telemetry and no external release server.

## Publishing a release

1. Make sure `main` is green in CI and the changelog is up to date (`CHANGELOG.md`: move "Unreleased" under the
   new version).
2. Set the version everywhere (it must be the same in all five places) — for `0.1.1`:

   ```powershell
   npm version 0.1.1 --no-git-tag-version
   # edit src-tauri/tauri.conf.json  "version"
   # edit src-tauri/Cargo.toml       version = "0.1.1"   (then: cargo update -p peachterm --manifest-path src-tauri/Cargo.toml)
   node scripts/check-release-version.mjs v0.1.1
   git commit -am "chore: release 0.1.1"
   git push
   ```

3. Create and push the tag (use the exact version, with a leading `v`):

   ```powershell
   git tag -a v0.1.1 -m "PeachTerm 0.1.1"
   git push origin v0.1.1
   ```

   Examples of other valid tags: `v0.1.0`, `v0.1.0-alpha.1`, `v0.1.0-beta.1`, `v0.1.0-rc.1`.

## Monitoring and downloading

- Watch the run under the repository's **Actions → Release** tab.
- Published installers are under **Releases**. While the run is going (or if it failed) the draft is visible only
  to people with write access.
- A manual **dry run** builds everything without publishing: _Actions → Release → Run workflow_. The installers
  are kept for 7 days as workflow artifacts of that run.

## When something fails

- Open the failed job's log in **Actions**. Failed builds also upload whatever bundles were produced as a
  `failed-build-*` artifact.
- The draft release stays a draft. To retry from scratch: delete the draft release and the tag, fix the problem,
  then tag again:

  ```powershell
  git push --delete origin v0.1.1
  git tag -d v0.1.1
  ```

  (delete the draft in the GitHub UI first), then repeat "Publishing a release".

- If only one platform failed and you want to keep the others, re-run the failed jobs from the Actions page (the
  draft already exists), then publish the draft by hand once all five files are attached.
- To publish a complete draft manually: Releases → the draft → **Publish release**.

## Signing

Releases are not signed yet. See [signing.md](signing.md).
