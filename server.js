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
  const publicUrl = options.publicUrl !== undefined
    ? options.publicUrl
    : process.env.PUBLIC_URL || "";
  const server = createApp(options).listen(port, host, () => {
    console.log("Codex 状态灯已启动: http://localhost:" + port);
    if (publicUrl) console.log("公网访问地址: " + publicUrl);
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error("端口 " + port + " 已被占用。请关闭旧服务，或在 .env 中修改 PORT。");
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
