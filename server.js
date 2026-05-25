import express from "express";
import { randomUUID } from "crypto";

const DISTRU_API_KEY = process.env.DISTRU_API_KEY;
const SERVER_SECRET  = process.env.SERVER_SECRET;
const PORT           = process.env.PORT || 3000;

if (!DISTRU_API_KEY) { console.error("FATAL: DISTRU_API_KEY not set."); process.exit(1); }

async function distru(path, method = "GET", body = null) {
  const res = await fetch(`https://app.distru.com/public/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${DISTRU_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Distru ${method} ${path} → ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { v.forEach(item => p.append(`${k}[]`, String(item))); }
    else { p.set(k, String(v)); }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

const TOOLS = [
  { name: "get_inventory", description: "Get current inventory levels per batch. Returns batch_id, product, and quantities.", inputSchema: { type: "object", properties: { product_id: { type: "string" }, location_id: { type: "string" }, batch_id: { type: "string" }, page: { type: "number" } } } },
  { name: "get_products", description: "List all products — SKUs, categories, unit types, pricing, case sizes.", inputSchema: { type: "object", properties: { search: { type: "string" }, is_active: { type: "boolean" }, first: { type: "number" }, after: { type: "string" } } } },
  { name: "get_batches", description: "List batches. Each product can have multiple batches tracked separately.", inputSchema: { type: "object", properties: { product_id: { type: "string" }, search: { type: "string" }, first: { type: "number" }, after: { type: "string" } } } },
  { name: "create_batch", description: "Create a new batch under a product.", inputSchema: { type: "object", required: ["product_id", "name"], properties: { product_id: { type: "string" }, name: { type: "string" }, quantity: { type: "number" }, location_id: { type: "string" } } } },
  { name: "get_adjustments", description: "Get stock adjustment history.", inputSchema: { type: "object", properties: { batch_id: { type: "string" }, product_id: { type: "string" }, first: { type: "number" } } } },
  { name: "insert_stock_adjustment", description: "Adjust inventory on a batch. quantity is a DELTA (positive adds, negative removes). Always confirm with Nick before calling.", inputSchema: { type: "object", required: ["quantity", "reason", "description"], properties: { batch_id: { type: "string" }, product_id: { type: "string" }, quantity: { type: "number" }, reason: { type: "string", enum: ["waste","stolen","damaged","fire","write-off","expired","lab-testing","revaluation","other"] }, description: { type: "string" }, location_id: { type: "string" }, unit_cost: { type: "number" }, completion_datetime: { type: "string" } } } },
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
    case "get_inventory": {
      const p = new URLSearchParams();
      p.append("grouping[]", "PRODUCT");
      p.append("grouping[]", "BATCH_NUMBER");
      if (a.product_id) p.append("product_ids[]", a.product_id);
      if (a.location_id) p.append("location_ids[]", a.location_id);
      if (a.batch_id) p.append("batch_ids[]", a.batch_id);
      if (a.page) p.set("page", String(a.page));
      return await distru(`/inventory?${p.toString()}`);
    }
    case "get_products":            return await distru(`/products${qs({ first: 40, ...a })}`);
    case "get_batches":             return await distru(`/batches${qs({ first: 40, ...a })}`);
    case "create_batch":            return await distru("/batches", "POST", a);
    case "get_adjustments":         return await distru(`/adjustments${qs({ first: 20, ...a })}`);
    case "insert_stock_adjustment": {
      const body = { ...a };
      if (!body.completion_datetime) {
        const now = new Date();
        body.completion_datetime = now.toISOString().replace(/\.\d{3}Z$/, '.000000');
      }
      return await distru("/adjustments", "POST", body);
    }
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

// ─── OAuth discovery (required by claude.ai) ──────────────────────────────────
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

const OAUTH_META = {
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/authorize`,
  token_endpoint: `${BASE_URL}/token`,
  registration_endpoint: `${BASE_URL}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
};

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, Mcp-Session-Id");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  if (!SERVER_SECRET) return next();
  const token = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace("Bearer ", "");
  if (token !== SERVER_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "distru-mcp", ts: new Date().toISOString() }));

app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(OAUTH_META));
app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json({ resource: BASE_URL, authorization_servers: [BASE_URL] }));
app.post("/register", (_req, res) => res.status(201).json({ client_id: randomUUID(), client_secret: randomUUID(), token_endpoint_auth_method: "none" }));
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  const code = randomUUID();
  res.redirect(`${redirect_uri}?code=${code}&state=${state}`);
});
app.post("/token", (_req, res) => res.json({ access_token: SERVER_SECRET || "public", token_type: "bearer", expires_in: 86400 }));

// ─── MCP at root — direct JSON-RPC handler (bypasses SDK Accept-header issues) ──
app.head("/", (_req, res) => res.set("MCP-Protocol-Version", "2025-06-18").sendStatus(200));

app.post("/", auth, async (req, res) => {
  const body = req.body;
  if (!body || !body.method) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null });

  const id = body.id ?? null;
  try {
    if (body.method === "initialize") {
      return res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "distru-mcp", version: "1.0.0" } } });
    }
    if (body.method === "notifications/initialized") return res.status(204).send();
    if (body.method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      const result = await callTool(name, args);
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    }
    if (body.method === "ping") return res.json({ jsonrpc: "2.0", id, result: {} });
    return res.status(405).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  } catch (err) {
    return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
  }
});

app.get("/", (_req, res) => res.set("Allow", "POST").status(405).send());

app.listen(PORT, () => console.log(`Distru MCP ready on :${PORT}`));
