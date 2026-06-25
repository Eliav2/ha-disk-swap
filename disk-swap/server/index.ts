// Must be imported before any logging to capture all output
import { getLastLines } from "./logbuffer.ts";

// Catch crashes that bypass try-catch
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { StartCloneRequest } from "../shared/types.ts";
import { getCurrentJob, dismissJob, subscribe } from "./jobs.ts";
import { runClonePipeline, runSandboxOnlyPipeline, cancelClone } from "./clone.ts";
import { getImageCacheInfo, discardCachedImage } from "./images.ts";
import { signalSandboxDone, getSandboxProxyUrl } from "./sandbox.ts";

const isDev = process.env.DEV === "1";

const { listUsbDevices } = isDev
  ? await import("./mock.ts")
  : await import("./devices.ts");

const { getSystemInfo: getSystemInfoFn, listBackups: listBackupsFn } = isDev
  ? await import("./mock.ts")
  : await import("./supervisor.ts");

const app = new Hono();

// HA ingress produces double-slash paths (ingress_entry: / appended to token/)
// Normalize before routing so /api/devices matches //api/devices
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.includes("//")) {
    url.pathname = url.pathname.replace(/\/\/+/g, "/");
    return app.fetch(new Request(url, c.req.raw), c.env);
  }
  return next();
});

// --- API routes ---

app.get("/api/health", (c) => {
  return c.json({ status: "ok" });
});

app.get("/api/logs", (c) => {
  const n = Math.min(Number(c.req.query("lines") ?? 3), 100);
  return c.json({ lines: getLastLines(n) });
});

app.get("/api/devices", async (c) => {
  try {
    const devices = await listUsbDevices();
    return c.json({ devices });
  } catch (err) {
    console.error("Error listing devices:", err);
    return c.json(
      { error: "Failed to list devices", detail: String(err) },
      500,
    );
  }
});

// Cache the last good system-info. During the sandbox stage the addon's own
// Supervisor calls are transiently routed to the inner Supervisor (the policy
// route that lets HA Core reach it shares the addon's netns), so a live fetch
// can 403/500. system-info is effectively static during a run, so serving the
// cached copy keeps machine details and the "Full logs" link alive throughout.
let cachedSystemInfo: Awaited<ReturnType<typeof getSystemInfoFn>> | null = null;

app.get("/api/system-info", async (c) => {
  try {
    const info = await getSystemInfoFn();
    cachedSystemInfo = info;
    return c.json(info);
  } catch (err) {
    if (cachedSystemInfo) {
      console.warn("[system-info] live fetch failed, serving cached copy:", String(err));
      return c.json(cachedSystemInfo);
    }
    console.error("Error fetching system info:", err);
    return c.json(
      { error: "Failed to fetch system info", detail: String(err) },
      500,
    );
  }
});

// --- Backups API ---

app.get("/api/backups", async (c) => {
  try {
    const backups = await listBackupsFn();
    return c.json({ backups });
  } catch (err) {
    console.error("Error listing backups:", err);
    return c.json(
      { error: "Failed to list backups", detail: String(err) },
      500,
    );
  }
});

// --- Image Cache API ---

app.get("/api/image-cache", async (c) => {
  try {
    const info = await getSystemInfoFn();
    const { cached, sizeBytes } = await getImageCacheInfo(info.board_slug, info.os_version);
    if (!cached) return c.json({ cached: false });
    const sizeHuman = sizeBytes >= 1024 ** 3
      ? `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.round(sizeBytes / 1024 ** 2)} MB`;
    return c.json({
      cached: true,
      version: info.os_version,
      board: info.board_slug,
      size_bytes: sizeBytes,
      size_human: sizeHuman,
    });
  } catch (err) {
    console.error("Error checking image cache:", err);
    return c.json({ error: "Failed to check image cache", detail: String(err) }, 500);
  }
});

app.delete("/api/image-cache", async (c) => {
  try {
    const info = await getSystemInfoFn();
    discardCachedImage(info.board_slug, info.os_version);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Error discarding image cache:", err);
    return c.json({ error: "Failed to discard image cache", detail: String(err) }, 500);
  }
});

// --- Clone API ---

app.post("/api/start-clone", async (c) => {
  try {
    const body = await c.req.json<StartCloneRequest>();
    if (!body.device) {
      return c.json({ error: "Missing 'device' field" }, 400);
    }

    const job = await runClonePipeline(body.device, body.backup_slug, body.skip_flash, body.skip_sandbox);
    return c.json({ job_id: job.id });
  } catch (err) {
    console.error("Start clone failed:", err);
    return c.json({ error: String(err) }, 400);
  }
});

app.post("/api/cancel-clone", (c) => {
  cancelClone();
  return c.json({ ok: true });
});

app.post("/api/start-sandbox", async (c) => {
  try {
    const body = await c.req.json<{ device?: string; no_restore?: boolean }>();
    if (!body.device) {
      return c.json({ error: "Missing 'device' field" }, 400);
    }
    const job = await runSandboxOnlyPipeline(body.device, body.no_restore === true);
    return c.json({ job_id: job.id });
  } catch (err) {
    console.error("Start sandbox failed:", err);
    return c.json({ error: String(err) }, 400);
  }
});

app.get("/api/jobs/current", (c) => {
  const job = getCurrentJob();
  if (!job) {
    return c.json({ error: "No active job" }, 404);
  }
  return c.json(job);
});

app.delete("/api/jobs/current", (c) => {
  dismissJob();
  return c.json({ ok: true });
});

// --- WebSocket for real-time progress ---

app.get(
  "/ws/progress",
  upgradeWebSocket(() => {
    let unsubscribe: (() => void) | null = null;

    return {
      onOpen(_event, ws) {
        // Send current job snapshot for reconnection
        const job = getCurrentJob();
        if (job) {
          for (const stage of Object.values(job.stages)) {
            ws.send(
              JSON.stringify({
                type: "stage_update",
                stage: stage.name,
                status: stage.status,
                progress: stage.progress,
                description: stage.description,
                speed: stage.speed,
                eta: stage.eta,
              }),
            );
          }
          if (job.status === "completed") {
            ws.send(JSON.stringify({ type: "done", backupName: job.backupName }));
          } else if (job.status === "failed" && job.error) {
            const failedStage = Object.values(job.stages).find(
              (s) => s.status === "failed",
            );
            ws.send(
              JSON.stringify({
                type: "error",
                stage: failedStage?.name || "backup",
                message: job.error,
              }),
            );
          }
        }

        // Subscribe to future updates
        unsubscribe = subscribe((msg) => {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* client disconnected */
          }
        });
      },
      onClose() {
        unsubscribe?.();
      },
    };
  }),
);

// --- Sandbox API ---

// Signal the sandbox stage that the user has finished restoring their backup
app.post("/api/sandbox-done", (c) => {
  signalSandboxDone();
  return c.json({ ok: true });
});

// Fast same-origin probe used by the frontend to decide when to render the
// sandbox iframe. Returns whether the inner-HA proxy is wired up. Replaces the
// previous cross-origin no-cors probe which suffered from variable inner-HA
// response times triggering 3s AbortSignal timeouts → multi-cycle retries →
// long "Connecting to sandbox instance…" spinner after a page reload.
app.get("/api/sandbox/ready", (c) => {
  return c.json({ ready: getSandboxProxyUrl() !== null });
});

// --- Sandbox direct-port proxy ---
//
// The inner HA Core (127.0.0.1:8123) is exposed on a SEPARATE port (8124) so the
// browser connects to a different origin than the outer HA (port 8123).
// Different port = different origin = isolated localStorage/cookies/auth.
// No JS interception or HTML path rewriting needed: HA's absolute paths like
// /frontend_latest/x.js resolve to 192.168.64.2:8124/frontend_latest/... which
// proxies straight to the inner HA — the right scripts, the right auth state.
const SANDBOX_PROXY_PORT = 8124;

/** Proxy a request to the inner HA Core. Shared by the port-8124 server and the ingress fallback route. */
async function proxySandboxRequest(req: Request): Promise<Response> {
  const proxyBase = getSandboxProxyUrl();
  if (!proxyBase) {
    return new Response("Sandbox not ready\n", { status: 503, headers: { "content-type": "text/plain" } });
  }

  try {
    const url = new URL(req.url);
    const target = `${proxyBase}${url.pathname}${url.search}`;

    const proxyHeaders = new Headers(req.headers);
    proxyHeaders.set("host", new URL(proxyBase).host);
    // ROOT-CAUSE FIX for the intermittent inner-UI spinner:
    // Bun's fetch keeps a keep-alive connection pool to the inner HA Core. After
    // the iframe sits idle (e.g. the user reloads the page — the app shell loads
    // from HA's 31-day cache with NO network, so the upstream socket goes idle),
    // HA Core (aiohttp) closes its end of the pooled socket. The next request —
    // typically the uncacheable /api/onboarding the frontend MUST have — reuses
    // that dead socket and throws "Unable to connect" → we returned 502 → the
    // frontend gives up → eternal spinner. Internal sequential curls never hit
    // it because their sockets stay warm. Two-part fix:
    //   1. Connection: close — tell HA Core not to keep-alive, so Bun won't pool
    //      a socket that can later go stale under us.
    //   2. Retry the upstream fetch on connect-failure (and on HA's transient
    //      startup 503) for idempotent GET/HEAD, with a fresh connection.
    proxyHeaders.set("connection", "close");
    proxyHeaders.delete("keep-alive");

    const isReplayable = ["GET", "HEAD"].includes(req.method);
    const body = isReplayable ? undefined : await req.arrayBuffer();

    const doFetch = () => fetch(target, { method: req.method, headers: proxyHeaders, body });

    let res: Response;
    if (isReplayable) {
      const deadline = Date.now() + 20_000;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          res = await doFetch();
        } catch (err) {
          // Connect-level failure (stale socket / brief Core blip). Retry fresh.
          if (Date.now() >= deadline) throw err;
          console.warn(`[sandbox-proxy] upstream connect failed (attempt ${attempt}), retrying:`, String(err));
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        // Absorb HA Core's transient "Home Assistant is starting" 503.
        if (res.status === 503 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 750));
          continue;
        }
        break;
      }
    } else {
      res = await doFetch();
    }

    const headers = new Headers(res.headers);
    // Allow embedding in our addon iframe
    headers.delete("x-frame-options");
    headers.delete("content-security-policy");
    // Avoid duplicate Date header (inner HA + Bun both add one → 502)
    headers.delete("date");
    // Bun auto-decompresses but keeps Content-Encoding → mismatch → client errors
    headers.delete("content-encoding");

    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    console.error("[sandbox-proxy] Proxy error:", err);
    return new Response("Sandbox proxy error — inner HA may not be ready yet\n", {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
}

// WebSocket bridge state attached to each upgraded client socket.
type SandboxWsData = {
  target: string;
  upstream: WebSocket | null;
  // Frames the browser sends before the upstream socket finishes opening.
  queue: (string | ArrayBufferLike | Uint8Array)[];
};

Bun.serve<SandboxWsData>({
  port: SANDBOX_PROXY_PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  fetch(req, server) {
    // HA's frontend opens ws://host:8124/api/websocket to load config/auth.
    // Without proxying this upgrade the UI hangs forever on the loading spinner
    // (JS loads over HTTP, but the WS that feeds it state never connects).
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const proxyBase = getSandboxProxyUrl();
      if (!proxyBase) {
        return new Response("Sandbox not ready\n", { status: 503 });
      }
      const url = new URL(req.url);
      const target = `${proxyBase.replace(/^http/, "ws")}${url.pathname}${url.search}`;
      if (server.upgrade(req, { data: { target, upstream: null, queue: [] } })) {
        return undefined; // upgraded — handled by `websocket` callbacks below
      }
      return new Response("WebSocket upgrade failed\n", { status: 500 });
    }
    return proxySandboxRequest(req);
  },
  websocket: {
    open(ws) {
      const upstream = new WebSocket(ws.data.target);
      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const frame of ws.data.queue) upstream.send(frame as any);
        ws.data.queue = [];
      };
      upstream.onmessage = (e) => {
        try {
          ws.send(e.data as string | ArrayBufferLike);
        } catch {
          /* client gone */
        }
      };
      upstream.onclose = (e) => {
        try {
          ws.close(e.code || 1000, e.reason);
        } catch {
          /* already closed */
        }
      };
      upstream.onerror = () => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else {
        ws.data.queue.push(message);
      }
    },
    close(ws) {
      try {
        ws.data.upstream?.close();
      } catch {
        /* already closed */
      }
    },
  },
});

console.log(`Sandbox proxy listening on port ${SANDBOX_PROXY_PORT}`);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// --- Static files (web UI) ---

const staticRoot = isDev ? "./rootfs/var/www" : "/var/www";
app.use("*", serveStatic({ root: staticRoot }));
app.get("*", serveStatic({ path: `${staticRoot}/index.html` }));

const PORT = Number(process.env.INGRESS_PORT) || 8099;

export default {
  port: PORT,
  fetch: app.fetch,
  websocket,
};

console.log(
  `Disk Swap server listening on port ${PORT}${isDev ? " (dev mode)" : ""}`,
);
