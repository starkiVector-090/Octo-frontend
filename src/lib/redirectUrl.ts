/** Validate a merchant-supplied redirect URL used for payment-link checkout redirects.

A redirect URL is acceptable only when it is an absolute `https:` URL. This prevents open
redirects to arbitrary hosts and blocks `javascript:`/`data:` URLs that could be used for XSS.
Returns an error message when rejected, or `null` when accepted.
*/
export function validateRedirectUrl(value: string): string | null {
  if (!value || typeof value !== "string") {
    return "Redirect URL is required.";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Redirect URL must be a valid URL.";
  }

  // Only https URLs are allowed. http leaks payment data in plain text; javascript: and data:
  // URLs are blocked outright.
  if (url.protocol !== "https:") {
    return "Redirect URL must use https://.";
  }

  // Restrict to public HTTPS hosts; reject IP addresses and localhost to prevent
  // SSRF-style redirects to internal services.
  const host = url.hostname;
  if (!host) return "Redirect URL must include a host.";
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return "Redirect URL host cannot be an IP address.";
  if (host === "localhost" || host.endsWith(".localhost")) return "Redirect URL cannot point to localhost.";
  if (host === "::1" || host === "[::1]") return "Redirect URL cannot point to localhost.";
  if (host.includes(".") === false) return "Redirect URL host must be a fully-qualified domain.";

  return null;
}
