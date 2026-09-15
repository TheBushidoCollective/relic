/**
 * The one address the hosted service answers on.
 *
 * Here rather than in either end because both ends have to agree about it and
 * they agree about nothing else. The publishing client resolves it when
 * nothing names another origin, and the service's own install page uses it to
 * decide whether its instructions need to mention an origin at all.
 *
 * Two copies of this string would drift, and the shape of that drift is an
 * install page telling a reader to configure the host they are already on, or
 * omitting the configuration a self-hoster needs. Both are silent: the page
 * renders, the copy reads fine, and only the person following it finds out.
 */
export const HOSTED_SERVICE_ORIGIN = 'https://relik.link';

/**
 * Whether a deployment is the hosted service rather than somebody's own.
 *
 * Compares origins rather than strings, so a trailing slash or a path on
 * either side cannot make the hosted service look self-hosted. An
 * unparseable value is somebody's own by definition: the hosted address
 * parses.
 */
export function isHostedService(serviceOrigin: string): boolean {
  try {
    return new URL(serviceOrigin).origin === HOSTED_SERVICE_ORIGIN;
  } catch {
    return false;
  }
}
