const express = require("express");
const path = require("path");
require("dotenv").config();

const { readCodexStatus } = require("./codex-status");

const app = express();
const PORT = process.env.PORT || 3456;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(readCodexStatus());
});

const server = app.listen(PORT, HOST, () => {
  console.log("Codex 状态灯已启动: http://localhost:" + PORT);
  if (PUBLIC_URL) console.log("公网访问地址: " + PUBLIC_URL);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("端口 " + PORT + " 已被占用。请关闭旧服务，或在 .env 中修改 PORT。");
    process.exit(1);
  }
  throw err;
});
