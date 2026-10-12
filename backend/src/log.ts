import pino from "pino";

/** Structured JSON logs. Never log keys, signatures of keys, or auth tokens. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["*.key", "*.privateKey", "*.token", "*.authorization", "req.headers.authorization"], censor: "[redacted]" },
});
