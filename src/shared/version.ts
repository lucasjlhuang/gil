/**
 * How gil names a build. The version is `package.json`'s (semantic versioning, 0.x until
 * the first public release); the commit identifies exactly which code a build came from, with
 * `-dirty` when it was built from uncommitted changes.
 */
export function versionLabel(version: string, commit: string): string {
  return commit && commit !== 'unknown' ? `${version} (${commit})` : version
}

/** `v0.2.0` for version `0.2.0`: the git tag a release of it carries. */
export function releaseTag(version: string): string {
  return `v${version}`
}
