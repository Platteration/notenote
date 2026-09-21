import pkg from "../../package.json";

/**
 * What the About card and the health endpoint report.
 *
 * Read from package.json at build time rather than from `npm_package_version`: npm sets that
 * for `npm start`, and it is unset when the server is started as `next start` directly, which
 * is what a Docker CMD or a systemd unit does.
 */
export const APP_NAME = "The Daily Scroll";
export const APP_VERSION: string = pkg.version;
export const SOURCE_URL = "https://github.com/Platteration/notenote";
