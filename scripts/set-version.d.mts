// Types for scripts/set-version.mjs (used by the TypeScript tests in tests/integration).
export interface Versions {
  packageJson: string;
  swift: string;
  plist: string;
  cmake: string;
}
export const VERSION_FILES: { readonly packageJson: string; readonly swift: string; readonly plist: string; readonly cmake: string };
export function readVersions(root?: string): Versions;
export function checkVersions(root?: string): string[];
export function setVersion(version: string, root?: string): Versions;
