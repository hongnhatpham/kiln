# Automatic releases

Kiln uses GitHub Actions on its public repository. Every push to `main` and every pull request checks the code, builds four native apps, installs each app twice to check updates, and imports, optimizes and exports a synthetic model through the installed application.

## Publish a version

1. Update `version` in `package.json` and write `docs/release-notes.md` for the version.
2. Commit and push to `main`. Wait for **Desktop apps** to pass.
3. Tag that exact commit with the matching version and push the tag:

```sh
git tag v0.1.2
git push origin v0.1.2
```

The tag must match the package version. The workflow creates a draft release, builds and checks Windows x64, Linux x64, macOS Apple Silicon and macOS Intel, and uploads their downloads directly to the draft. When all four pass, it downloads the complete set, calculates SHA256 checksums, adds the installation scripts and publishes the release as latest. The scripts then install that version automatically.

If a job fails, the release stays unpublished. Fix the problem before publishing. GitHub's **Re-run failed jobs** can retry transient runner failures; uploads to a draft replace only the matching platform files. Source fixes require a new version and tag. Published downloads are never replaced by the pipeline.

## Free GitHub accounts

No paid service, personal access token or signing subscription is needed. The workflow uses the built-in `GITHUB_TOKEN` and standard hosted runners. GitHub provides free standard runner execution for public repositories. Large binaries go directly to Releases, which avoids the 500 MB GitHub Free Actions artifact allowance. No Actions artifacts are uploaded. Verification results remain in job logs and summaries; binary releases remain downloadable. Dependency caches use GitHub's normal bounded cache allowance.

- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Standard hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Release asset limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

Keep the repository public to retain free standard runner execution. Builds are unsigned. Windows and macOS users may need their operating system's normal approval to open Kiln.

## Checks and limits

The workflow runs type checks, lint, formatting and logic tests before packaging. It verifies actual Start/app menu installation and updates on Windows, Ubuntu and both Mac architectures. Ubuntu uses the native Debian package with sandboxing enabled and a software graphics driver in its virtual display. Intel Mac hosted runners may have no usable graphics, so that runner can verify the graphics-unavailable fallback while still processing and exporting. Apple Silicon and Windows require a working 3D preview. RPM packages are built and their installer selection is tested, but a Fedora desktop is not exercised.

Only synthetic fixture data is used in public CI. Private source scans and screenshots never enter release downloads or CI logs.
