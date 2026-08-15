import { createRequire } from "node:module";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapSessionEvent } from "./agent-event.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const WRITE_TIMEOUT_MS = 150;
const MAX_QUEUE = 1024;
const MAX_TOOL_NAMES = 1024;

/**
 * Normalize the two optional patch config fields by hand. This plugin
 * deliberately has no `static Config` schema: Cordis passes the raw config
 * through unchanged when no schema is declared, and avoiding a schemastery
 * runtime import means the installed package only needs files Agent Cat
 * actually ships (plus the DSH platform itself).
 */
function normalizeConfig(config) {
  const value = config ?? {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    endpoint: typeof value.endpoint === "string" && value.endpoint ? value.endpoint : "",
  };
}

function defaultEndpoint() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return path.join(appdata, "io.github.agent-cat", "agent-cat.endpoint");
    return "";
  }
  const home = os.homedir();
  return path.join(home, ".config", "agent-cat", "agent-cat.sock");
}

function connectEndpoint(endpoint) {
  return new Promise((resolve, reject) => {
    const open = (socket) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      socket.once("connect", () => {
        settled = true;
        resolve(socket);
      });
      socket.once("error", fail);
      // Without this listener a connect timeout would leave the promise (and
      // therefore the whole drain queue) pending forever.
      socket.once("timeout", () => {
        socket.destroy();
        fail(new Error(`timeout connecting to ${endpoint}`));
      });
      return socket;
    };

    // macOS: Unix domain socket; Windows: a file containing a loopback port.
    if (process.platform === "win32") {
      const port = (() => {
        try {
          const value = fs.readFileSync(endpoint, "utf8").trim();
          const n = Number.parseInt(value, 10);
          return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
        } catch {
          return null;
        }
      })();
      if (port === null) return reject(new Error(`invalid endpoint ${endpoint}`));
      open(net.connect({ host: "127.0.0.1", port, timeout: WRITE_TIMEOUT_MS }));
      return;
    }
    open(net.connect({ path: endpoint, timeout: WRITE_TIMEOUT_MS }));
  });
}

/**
 * Forward one sanitized Agent Cat event over the local socket. Never throws:
 * the agent loop must not be disturbed by a reporting failure.
 */
async function sendAgentCatEvent(endpoint, event) {
  if (!endpoint) return;
  try {
    const socket = await connectEndpoint(endpoint);
    socket.setTimeout(WRITE_TIMEOUT_MS);
    await new Promise((resolve) => {
      const onError = () => {
        socket.destroy();
        resolve();
      };
      const onTimeout = () => {
        socket.destroy();
        resolve();
      };
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
      socket.end(`${JSON.stringify(event)}\n`, () => {
        socket.destroy();
        resolve();
      });
    });
  } catch {
    // Best-effort only; a missing Agent Cat receiver is not an error.
  }
}

/**
 * The Agent Cat DeepSeek Harness bridge plugin. Unlike a telemetry backend, it
 * does NOT register the `sessionTelemetry` service — that seam is already owned
 * by `dsh-session-telemetry-otel` in the base bundle. Subscribing to the
 * `session/event` firehose directly means this plugin coexists with (and never
 * disturbs) the deployment's telemetry configuration.
 */
export class AgentCatSessionPlugin {
  static inject = ["sessions"];

  #endpoint;
  #enabled;
  #queue = [];
  #draining = false;
  #toolNames = new Map();

  constructor(ctx, config) {
    const normalized = normalizeConfig(config);
    this.#endpoint = normalized.endpoint || defaultEndpoint();
    this.#enabled = normalized.enabled;

    // Follow every committed session event from process start.
    ctx.on("session/event", (session, event) => {
      this.#enqueue(session, event);
    });

    // A session leaving the store has no appended event of its own, so map the
    // live store's disposal edge directly onto Agent Cat's `SessionEnd`.
    ctx.on("session/disposed", (session) => {
      this.#forgetToolNames(String(session.id));
      if (!this.#enabled || !this.#endpoint) return;
      this.#send({
        version: 1,
        agent: "dsh",
        sessionId: String(session.id),
        event: "SessionEnd",
        timestamp: Date.now(),
      });
    });

    if (!this.#enabled) return;
    if (this.#endpoint) {
      ctx.logger.info(
        `agent-cat: forwarding DeepSeek Harness events to ${this.#endpoint} (dsh-session-agent-cat ${version})`,
      );
    }
  }

  /**
   * Non-blocking handoff: session/event is emitted synchronously after each
   * append, so the socket write is deferred to a microtask and any queue
   * overflow is dropped rather than blocking the agent loop.
   */
  #enqueue(session, event) {
    if (!this.#enabled || !this.#endpoint) return;
    const sessionId = String(session.id);
    if (event.type === "tool/call") {
      this.#rememberToolName(sessionId, event.data);
    }
    const mapped = mapSessionEvent(session, event, this.#toolNames);
    if (event.type === "turn/end") this.#forgetToolNames(sessionId);
    if (!mapped) return;
    this.#send(mapped);
  }

  /**
   * Keep a bounded `sessionId\0callId → name` index. `tool/result` carries
   * only the `toolCallId`, so this is the sole way to report which tool just
   * finished.
   */
  #rememberToolName(sessionId, data) {
    const callId = data?.callId;
    const name = data?.name;
    if (typeof callId !== "string" || typeof name !== "string") return;
    const key = `${sessionId}\0${callId}`;
    this.#toolNames.delete(key);
    while (this.#toolNames.size >= MAX_TOOL_NAMES) {
      const oldest = this.#toolNames.keys().next().value;
      if (oldest === undefined) break;
      this.#toolNames.delete(oldest);
    }
    this.#toolNames.set(key, name);
  }

  #forgetToolNames(sessionId) {
    const prefix = `${sessionId}\0`;
    for (const key of this.#toolNames.keys()) {
      if (key.startsWith(prefix)) this.#toolNames.delete(key);
    }
  }

  #send(event) {
    if (!this.#enabled || !this.#endpoint) return;
    if (this.#queue.length >= MAX_QUEUE) {
      this.#queue.shift();
    }
    this.#queue.push(event);
    void this.#drain();
  }

  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const batch = this.#queue;
        this.#queue = [];
        for (const event of batch) await sendAgentCatEvent(this.#endpoint, event);
      }
    } finally {
      this.#draining = false;
    }
  }
}

export default AgentCatSessionPlugin;
