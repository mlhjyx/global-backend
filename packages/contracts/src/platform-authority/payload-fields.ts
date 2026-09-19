import { z } from "zod";

/** Shared payload syntax only; none of these schemas establishes trust or freshness. */
export const platformAuthorityUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const platformAuthoritySchedule = z.enum([
  "acq-sweep",
  "intent-sweep",
  "sanctions-refresh",
  "patents-cache-refresh",
]);
export const platformAuthorityNumericDate = z
  .number()
  .int()
  .nonnegative()
  .max(253402300799);
export const platformAuthorityIssuer = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      if (
        [...value].some(
          (character) =>
            character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
        )
      )
        return false;
      const uri = new URL(value);
      return (
        !uri.username &&
        !uri.password &&
        !uri.search &&
        !uri.hash &&
        (uri.protocol === "https:" ||
          (uri.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(uri.hostname)))
      );
    } catch {
      return false;
    }
  });

export function platformAuthorityBoundedTokenWindow(value: {
  iat: number;
  nbf: number;
  exp: number;
}): boolean {
  return (
    value.iat <= value.nbf &&
    value.nbf < value.exp &&
    value.exp - value.iat <= 300
  );
}
