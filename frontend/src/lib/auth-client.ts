import { createAuthClient } from "better-auth/react";

/**
 * Browser calls `/api/auth/*` on the Next origin; `next.config` rewrites to Express.
 * Omit baseURL so requests stay same-origin (cookies work).
 */
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
});
