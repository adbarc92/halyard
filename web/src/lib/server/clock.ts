/** Injectable clock; ISO-8601 strings, matching Halyard's `now: () => string` ports. */
export type Clock = () => string;
export const systemClock: Clock = () => new Date().toISOString();
