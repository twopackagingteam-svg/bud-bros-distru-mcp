import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";

const DISTRU_API_KEY = process.env.DISTRU_API_KEY;
const SERVER_SECRET  = process.env.SERVER_SECRET;
const PORT           = process.env.PORT || 3000;
const BASE_URL       = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

if (!DISTRU_API_KEY) {
  console.error("FATAL: DISTRU_API_KEY is not set.");
  process.exit(1);
}

async function distru(path, method = "GET", body = null) {
  const res = await fetch(`https://app.distru.com/public/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${DISTRU_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Distru ${method} ${path} → ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {}))
    if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const TOOLS = [
  { name: "get_inventory", description: "Get current inventory levels for all products and batches. Returns active, available, and reserved quantities per batch per location.", inputSchema: { type: "object", properties: { product_id: { type: "string" }, location_id: { type: "string" }, search: { type: "string" } } } },
  { name: "get_products", description: "List all products — SKUs, categories, unit types, pricing, case sizes.", inputSchema: { type: "object", properties: { search: { type: "string" }, is_active: { type: "boolean" }, first: { type: "number" }, after: { type: "string" } } } },
  { name: "get_batches", description: "List batches. Each product can have unlimited batches, each tracked separately.", inputSchema: { type: "object", properties: { product_id: { type: "string" }, search: { type: "string" }, first: { type: "number" }, after: { type: "string" } } } },
  { name: "create_batch", description: "Create a new batch under a product.", inputSchema: { type: "object", required: ["product_id", "name"], properties: { product_id: { type: "string" }, name: { type: "string" }, quantity: { type: "number" }, location_id: { type: "string" } } } },
  { name: "get_adjustments", description: "Get stock adjustment history.", inputSchema: { type: "object", properties: { batch_id: { type: "string" }, product_id: { type: "string" }, first: { type: "number" } } } },
  { name: "insert_stock_adjustment", description: "Adjust inventory on a batch. Positive quantity adds stock, negative removes. ALWAYS confirm with Nick in chat before calling this.", inputSchema: { type: "object", required: ["batch_id", "quantity", "reason"], properties: { batch_id: { type: "string" }, quantity: { type: "number" }, reason: { type: "string", enum: ["physical_count","waste","sample","theft","damage","return","other"] }, note: { type: "string" }, location_id: { type: "string" } } } },
  { name: "get_locations", description: "List all locations in Distru.", inputSchema: { type: "object", properties: {} } },
  { name: "get_contacts", description: "List dispensary contacts and customers.", inputSchema: { type: "object", properties: { search: { type: "string" }, first: { type: "number" }, after: { type: "string" } } } },
  { name: "get_orders", description: "List sales orders.", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["draft","pending","confirmed","invoiced","complete","cancelled"] }, contact_id: { type: "string" }, first: { type: "number" }, after: { type: "string" } } } },
  { name: "get_order", description: "Get one order with full line item details.", inputSchema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string" } } } },
  { name: "get_strains", description: "List all strains configured in Distru.", inputSchema: { type: "object", properties: { search: { type: "string" } } } },
  { name: "get_packages", description: "List Metrc packages.", inputSchema: { type: "object", properties: { product_id: { type: "string" }, first: { type: "number" } } } },
  { name: "upsert_product", description: "Create or update a product.", inputSchema: { type: "object", required: ["name"], properties: { id: { type: "string" }, name: { type: "string" }, sku: { type: "string" }, unit_price: { type: "number" }, units_per_case: { type: "number" }, is_active: { type: "boolean" } } } }
];

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case "get_inventory":           return await distru(`/inventory${qs({ grouping: "product", first: 100, ...a })}`);
    case "get_products":            return await distru(`/products${qs({ first: 40, ...a })}`);
    case "get_batches":             return await distru(`/batches${qs({ first: 40, ...a })}`);
    case "create_batch":            return await distru("/batches", "POST", a);
    case "get_adjustments":         return await distru(`/stock_adjustments${qs({ first: 20, ...a })}`);
    case "insert_stock_adjustment": return await distru("/stock_adjustments", "POST", a);
    case "get_locations":           return await distru("/locations");
    case "get_contacts":            return await distru(`/contacts${qs({ first: 40, ...a })}`);
    case "get_orders":              return await distru(`/orders${qs({ first: 20, ...a })}`);
    case "get_order":               return await distru(`/orders/${a.order_id}`);
    case "get_strains":             return await distru(`/strains${qs(a)}`);
    case "get_packages":            return await distru(`/packages${qs({ first: 20, ...a })}`);
    case "upsert_product":          return await distru("/products", "POST", a);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleJsonRpc(body) {
  const { method, params, id } = body;
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "distru-mcp", version: "1.0.0" },
        },
      };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params;
      const result = await callTool(name, args);
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      };
    }
    if (method === "notifications/initialized" || method === "ping") {
      return id != null ? { jsonrpc: "2.0", id, result: {} } : null;
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: err.message } };
  }
}

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, Mcp-Session-Id, MCP-Protocol-Version, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  if (!SERVER_SECRET) return next();
  const token = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token !== SERVER_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Health check
app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "distru-mcp", ts: new Date().toISOString() })
);

// OAuth 2.0 Protected Resource Metadata (RFC 9728)
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ["header", "query"],
  });
});

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
    code_challenge_methods_supported: ["S256"],
  });
});

// OAuth Dynamic Client Registration (RFC 7591)
app.post("/register", (req, res) => {
  const clientId = randomUUID();
  res.status(201).json({
    client_id: clientId,
    client_secret: "none",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: req.body?.redirect_uris || [],
    grant_types: ["authorization_code", "client_credentials"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// OAuth Authorization endpoint
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("Missing redirect_uri");
  const code = randomUUID();
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

// OAuth Token endpoint
app.post("/token", (req, res) => {
  res.json({
    access_token: SERVER_SECRET || randomUUID(),
    token_type: "bearer",
    expires_in: 86400,
    scope: "mcp",
  });
});

// SSE transport (legacy)
const sseSessions = {};

app.get("/sse", auth, async (req, res) => {
  const mcpSrv = buildMcpServer();
  const transport = new SSEServerTransport("/messages", res);
  sseSessions[transport.sessionId] = transport;
  res.on("close", () => delete sseSessions[transport.sessionId]);
  await mcpSrv.connect(transport);
});

function buildMcpServer() {
  const srv = new Server(
    { name: "distru-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await callTool(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
  return srv;
}

app.post("/messages", async (req, res) => {
  const t = sseSessions[req.query.sessionId];
  if (!t) return res.status(404).json({ error: "Session not found — reconnect to /sse" });
  await t.handlePostMessage(req, res);
});

// StreamableHTTP — handle MCP at root / with manual JSON-RPC
// The MCP SDK's StreamableHTTPServerTransport checks Accept headers strictly (needs both
// application/json and text/event-stream). Instead we handle JSON-RPC directly.
const sessions = {};

app.head("/", (_req, res) => {
  res
    .set("MCP-Protocol-Version", "2024-11-05")
    .set("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version")
    .sendStatus(200);
});

app.get("/", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions[sessionId]) {
    // SSE stream for server-sent notifications
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Mcp-Session-Id": sessionId,
    });
    res.flushHeaders();
    sessions[sessionId].res = res;
    req.on("close", () => {
      if (sessions[sessionId]) sessions[sessionId].res = null;
    });
  } else {
    res.set("Allow", "POST").status(405).json({ error: "Use POST to initialize" });
  }
});

app.post("/", async (req, res) => {
  console.log("POST / headers:", JSON.stringify(req.headers));
  console.log("POST / body:", JSON.stringify(req.body));

  const sessionId = req.headers["mcp-session-id"] || randomUUID();

  // Handle batch or single request
  const requests = Array.isArray(req.body) ? req.body : [req.body];
  const responses = [];

  for (const rpc of requests) {
    if (!rpc || typeof rpc !== "object") continue;
    const resp = await handleJsonRpc(rpc);
    if (resp) responses.push(resp);

    // On initialize, set up session
    if (rpc.method === "initialize") {
      sessions[sessionId] = { res: null };
    }
  }

  res.set("Mcp-Session-Id", sessionId);
  res.set("MCP-Protocol-Version", "2024-11-05");

  if (responses.length === 0) {
    res.sendStatus(204);
  } else if (responses.length === 1) {
    res.json(responses[0]);
  } else {
    res.json(responses);
  }
});

app.delete("/", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions[sessionId]) {
    if (sessions[sessionId].res) sessions[sessionId].res.end();
    delete sessions[sessionId];
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => console.log(`Distru MCP ready on :${PORT}`));
