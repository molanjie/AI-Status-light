const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pairs = [
  ["public/index.html", "docs/index.html"],
  ["public/status-connection.js", "docs/status-connection.js"],
];

for (const [source, target] of pairs) {
  fs.copyFileSync(path.join(root, source), path.join(root, target));
}
