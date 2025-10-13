import "./utils/dotenv.js";

import express from "express";
import { serveHTTP } from "./addon/server.js";
import { router } from "./router.js";
import { serveHTTPS } from "./utils/https.js";

const PORT = Number(process.env.PORT) || 58827;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 58828;

// Initialize Sentry (optional, requires Node.js 18+)
const initializeSentry = async () => {
  const SENTRY_DSN = process.env.SENTRY_DSN;

  if (!SENTRY_DSN) {
    console.log("Sentry DSN not provided, error tracking disabled");
    return null;
  }

  try {
    const Sentry = await import("@sentry/node");
    const { nodeProfilingIntegration } = await import("@sentry/profiling-node");

    Sentry.init({
      dsn: SENTRY_DSN,
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 0.1,
      profilesSampleRate: 0.1,
      environment: process.env.NODE_ENV || "production",
    });

    console.log("Sentry initialized successfully");
    return Sentry;
  } catch (error: any) {
    console.warn("Failed to initialize Sentry (Node.js 18+ required):", error?.message);
    return null;
  }
};

// Main application
const main = async () => {
  const Sentry = await initializeSentry();

  try {
    const app = await serveHTTP(PORT);
    app.use(express.json()).use(router);

    if (Sentry) {
      Sentry.setupExpressErrorHandler(app);
    }

    await serveHTTPS(app, HTTPS_PORT);

    console.log(`Server started successfully on ports ${PORT} (HTTP) and ${HTTPS_PORT} (HTTPS)`);
  } catch (error) {
    console.error("Failed to start server:", error);
    Sentry?.captureException(error);
    process.exit(1);
  }
};

main();


