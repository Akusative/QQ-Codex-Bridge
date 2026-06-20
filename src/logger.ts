import pino, { type DestinationStream } from "pino";

export function createLogger(level = "info", destination?: DestinationStream) {
  const options = {
    level,
    redact: {
      paths: ["token", "accessToken", "authorization", "headers.authorization"],
      censor: "[REDACTED]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
