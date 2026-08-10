require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
// Bill uploads are compressed images encoded as base64, which can run a
// few hundred KB — the default 100kb JSON body limit is too small for that.
app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/members", require("./routes/members"));
app.use("/api/events", require("./routes/events"));
app.use("/api/transactions", require("./routes/transactions"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/bills", require("./routes/bills"));

// Serve the frontend (single static HTML file) so one deployed service
// covers both the API and the UI — no separate static host needed.
const frontendDir = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(frontendDir, "club-finance-tracker.html"));
});

// Catch-all error handler — every route uses asyncHandler() to funnel
// failures here instead of crashing the process on an unhandled rejection.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error, please try again." });
});

// Last-resort safety nets: log and keep running rather than take the
// whole app down for everyone over one bad request or a flaky DB blip.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Club Finance API running at http://localhost:${PORT}`);
});