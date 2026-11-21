/**
 * Express: accept uploads into a bounded in-memory workspace, list and serve them.
 * Run: npx tsx examples/express-uploads.ts  (then: curl -X PUT --data-binary @file http://localhost:3000/files/name)
 */
import express from "express";
import { pipeline } from "node:stream/promises";
import { createFs, expressMiddleware, serveStatic } from "memspace/express";

const fs = createFs({ name: "uploads", maxMemory: 64 * 1024 * 1024 });
fs.mkdirSync("/files");

const app = express();
app.use(expressMiddleware(fs, { attachToRequest: true }));

app.put("/files/:name", async (req, res, next) => {
  try {
    // Uploads expire after 10 minutes. ENOSPC is raised if the quota would be exceeded.
    await pipeline(req, req.memspace!.createWriteStream(`/files/${req.params.name}`, { ttl: 10 * 60_000 }));
    res.status(201).json(req.memspace!.statSync(`/files/${req.params.name}`).size);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") res.status(507).json({ error: "quota exceeded" });
    else next(error);
  }
});

app.get("/files", (_req, res) => {
  res.json({ files: fs.readdirSync("/files"), stats: fs.getStats() });
});

app.use("/files", serveStatic(fs, { root: "/files" }));

app.listen(3000, () => console.log("listening on http://localhost:3000"));
