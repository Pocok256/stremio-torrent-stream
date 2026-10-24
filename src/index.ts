import "./utils/logger.js";
import "./utils/sentry.js";

import express from "express";
import { serveHTTP } from "./addon/server.js";
import { router } from "./router.js";
import {
  captureException,
  flushSentry,
  setupSentryErrorHandler,
} from "./utils/sentry.js";
import { serveHTTPS } from "./utils/https.js";

const PORT = Number(process.env.PORT) || 58827;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 58828;

const main = async () => {
  const app = await serveHTTP(PORT);
  app.use(express.json()).use(router);
  setupSentryErrorHandler(app);
  await serveHTTPS(app, HTTPS_PORT);
};

main().catch(async (error) => {
  console.error("Failed to start application", error);
  captureException(error, {
    tags: {
      area: "startup",
    },
  });
  await flushSentry();
  process.exitCode = 1;
});
