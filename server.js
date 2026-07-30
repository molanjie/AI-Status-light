const express = require("express");
const path = require("path");
require("dotenv").config();

const { readCodexStatus } = require("./codex-status");

function createApp(options = {}) {
  const readStatus = options.readStatus || readCodexStatus;
  const startedAt = options.startedAt || Date.now();
  const now = options.now || Date.now;
  const app = express();

  app.use(express.static(path.join(__dirname, "public")));
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, startedAt, now: now() });
  });

  app.get("/api/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(readStatus());
  });

  return app;
}

function startServer(options = {}) {
  const port = options.port || process.env.PORT || 3456;
  const host = options.host || process.env.HOST || "0.0.0.0";
  const server = createApp(options).listen(port, host);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
