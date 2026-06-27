import axios from "axios";

/**
 * Extract a user-facing message from an unknown caught error.
 *
 * Prefers the backend's `{ error }` body, falls back to the axios/Error
 * message, then to the supplied default. Lets call sites use the
 * type-safe `catch (err)` (err: unknown) instead of `catch (err: any)`.
 */
export function apiErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error ?? err.message ?? fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
