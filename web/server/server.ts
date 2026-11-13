/**
 * The local dashboard: `npm run dashboard` serves the React app (web/dist) and its JSON API (src/api/, the same
 * handlers the Worker runs) over the daemon's SQLite file, on 127.0.0.1 only. `DB_PATH` moves the file (a relative
 * path is relative to daemon/), `PORT` the port (default 3000).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../../src/api/router";
import { localHost } from "./host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON = path.join(ROOT, "daemon");
const DIST = path.join(ROOT, "web", "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

export function dbFile(): string {
  const p = process.env.DB_PATH || "data/david.db";
  return path.isAbsolute(p) ? p : path.join(DAEMON, p);
}

/** A file of web/dist, or the app's index.html for its own routes (/tasks, /settings ...). */
function serveStatic(pathname: string, res: http.ServerResponse) {
  const wanted = path.join(DIST, path.normalize(decodeURIComponent(pathname)));
  const inside = wanted === DIST || wanted.startsWith(DIST + path.sep);
  const file = inside && fs.existsSync(wanted) && fs.statSync(wanted).isFile() ? wanted : path.join(DIST, "index.html");
  const asset = file !== path.join(DIST, "index.html") && pathname.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer(host: ReturnType<typeof localHost>): http.Server {
  return http.createServer(async (nreq, nres) => {
    try {
      const url = new URL(nreq.url ?? "/", `http://${nreq.headers.host ?? "127.0.0.1"}`);
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/oauth/")) return serveStatic(url.pathname, nres);

      const chunks: Buffer[] = [];
      for await (const chunk of nreq) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const method = nreq.method ?? "GET";
      const request = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks) });

      const response = await handle(request, host);
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") out[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      nres.writeHead(response.status, out);
      nres.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      nres.writeHead(500, { "Content-Type": "application/json" });
      nres.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("web/dist is missing: run `npm run build` first (`npm run dashboard` does it for you).");
    process.exit(1);
  }
  const host = localHost({ dbFile: dbFile(), schemaFile: path.join(DAEMON, "db", "schema.sql") });
  const port = Number(process.env.PORT) || 3000;
  createServer(host).listen(port, "127.0.0.1", () => console.log(`DAVID dashboard: http://127.0.0.1:${port}  (database: ${dbFile()})`));
}
