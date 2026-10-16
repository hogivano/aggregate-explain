/**
 * Read from package.json at build time is not worth the plumbing for one string;
 * `npm version` bumps this line and the manifest together via the release script.
 */
export const VERSION = '0.1.0';
