import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createFs, expressMiddleware, serveStatic, type MemspaceRequest } from "../../src/adapters/express.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("expressMiddleware", () => {
  it("exposes a shared instance via res.locals by default", async () => {
    const fs = createFs({ maxMemory: 1024 * 1024 });
    const app = express();
    app.use(expressMiddleware(fs));
    app.post("/files/:name", express.text(), (req, res) => {
      res.locals.memspace!.writeFileSync(`/${req.params.name}`, req.body as string);
      res.json({ attached: (req as Request).memspace !== undefined });
    });
    app.get("/files", (_req, res) => {
      res.json(fs.readdirSync("/"));
    });
    const base = await listen(app);
    const post = await fetch(`${base}/files/a.txt`, { method: "POST", body: "hello", headers: { "content-type": "text/plain" } });
    expect(await post.json()).toEqual({ attached: false });
    expect(await (await fetch(`${base}/files`)).json()).toEqual(["a.txt"]);
    expect(fs.readFileSync("/a.txt", "utf8")).toBe("hello");
  });

  it("optionally attaches to the request under a custom property", async () => {
    const fs = createFs();
    const app = express();
    app.use(expressMiddleware(fs, { attachToRequest: true, property: "space" }));
    app.get("/", (req, res) => {
      const r = req as MemspaceRequest<Request, "space">;
      r.space.writeFileSync("/request-data.json", JSON.stringify({ active: true }));
      res.json({ success: true });
    });
    const base = await listen(app);
    expect(await (await fetch(base)).json()).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync("/request-data.json", "utf8"))).toEqual({ active: true });
  });

  it("handles concurrent requests against one instance consistently", async () => {
    const fs = createFs();
    fs.writeFileSync("/log", "");
    const app = express();
    app.use(expressMiddleware(fs));
    app.post("/append/:n", async (req, res) => {
      await fs.promises.appendFile("/log", `${req.params.n}\n`);
      res.end();
    });
    const base = await listen(app);
    await Promise.all(Array.from({ length: 50 }, (_, i) => fetch(`${base}/append/${i}`, { method: "POST" })));
    const lines = fs.readFileSync("/log", "utf8").trim().split("\n");
    expect(new Set(lines).size).toBe(50);
  });

  it("forwards a 503 error after the instance is disposed", async () => {
    const fs = createFs();
    const app = express();
    app.use(expressMiddleware(fs));
    app.get("/", (_req, res) => res.send("ok"));
    app.use((err: { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).send(err.code);
    });
    const base = await listen(app);
    fs.dispose();
    const response = await fetch(base);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("ERR_MEMSPACE_DISPOSED");
  });

  it("rejects non-Memspace arguments", () => {
    expect(() => expressMiddleware({} as never)).toThrow(TypeError);
  });
});

describe("serveStatic", () => {
  it("streams files with content types and cannot escape its root", async () => {
    const fs = createFs();
    fs.mkdirSync("/public/css", { recursive: true });
    fs.mkdirSync("/secret");
    fs.writeFileSync("/public/index.html", "<h1>hi</h1>");
    fs.writeFileSync("/public/css/site.css", "body{}");
    fs.writeFileSync("/public/img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync("/secret/key", "nope");
    const app = express();
    app.use(serveStatic(fs, { root: "/public", fallthrough: false }));
    const base = await listen(app);

    const index = await fetch(`${base}/`);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toBe("<h1>hi</h1>");
    expect(await (await fetch(`${base}/css/site.css`)).text()).toBe("body{}");
    const png = await fetch(`${base}/img.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await fetch(`${base}/%2e%2e/secret/key`)).status).toBe(404);
    expect((await fetch(`${base}/missing`)).status).toBe(404);
    const head = await fetch(`${base}/css/site.css`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("6");
  });
});
