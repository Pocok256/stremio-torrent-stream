import "./dotenv.js";

import type { Application, ErrorRequestHandler } from "express";
import * as Sentry from "@sentry/node";

const parseBoolean = (value: string | undefined, defaultValue = false) => {
  if (value === undefined || value === "") return defaultValue;
  return value === "true";
};

const parseSampleRate = (value: string | undefined, defaultValue = 0) => {
  if (value === undefined || value === "") return defaultValue;

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return defaultValue;
  }

  return parsed;
};

const SENTRY_DSN = process.env.SENTRY_DSN?.trim();

export const sentryEnabled = Boolean(SENTRY_DSN);

if (sentryEnabled) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    profileSessionSampleRate: parseSampleRate(
      process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE
    ),
    profileLifecycle: "trace",
    enableLogs: parseBoolean(process.env.SENTRY_ENABLE_LOGS),
    sendDefaultPii: parseBoolean(process.env.SENTRY_SEND_DEFAULT_PII),
    shutdownTimeout: 5000,
    attachStacktrace: true,
    maxBreadcrumbs: 100,
  });
}

export type SentryCaptureContext = Parameters<typeof Sentry.captureException>[1];

export const captureException = (
  error: unknown,
  context?: SentryCaptureContext
) => {
  if (!sentryEnabled) return;
  Sentry.captureException(error, context);
};

export const flushSentry = async (timeout = 2000) => {
  if (!sentryEnabled) return true;
  return Sentry.close(timeout);
};

const requestErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  console.error("Unhandled request error", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).send("Internal Server Error");
};

export const setupSentryErrorHandler = (app: Application) => {
  if (sentryEnabled) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use(requestErrorHandler);
};