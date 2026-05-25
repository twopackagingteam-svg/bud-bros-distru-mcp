import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DISTRU_API_KEY = process.env.DISTRU_API_KEY;
const SERVER_SECRET  = process.env.SERVER_SECRET;
const PORT           = process.env.PORT || 3000;

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
  { name: "get_inventory", description: "Get current inventory levels for all products and batches. Returns active, available, and reserved quantities per batch per location.", inputSchema: { type: "object", properties: { product_id: { type: "string", description: "Filter by product ID" }, location_id: { type: "string", description: "Filter by location ID" }, search: { type: "string", description: "Search by product name" } } } },
  { name: "get_products", description: "List all products — SKUs, categories, unit types, pricing, case sizes.", inputSchema: { type: "object", properties: { search: { type: "string", description: "Search by product name" }, is_active: { type: "boolean", description: "Filter active/inactive" }, first: { type: "number", description: "Page size (default 40)" }, after: { type: "string", description: "Pagination cursor" } } } },
  { name: "get_batches", description: "List batches. Each product can have unlimited batches, each tracked separately.", inputSchema: { type: "object", properties: { product_id: { type: "string", description: "Filter by product ID" }, search: { type: "string", description: "Search by batch name" }, first: { type: "number", description: "Page size (default 40)" }, after: { type: "string", description: "Pagination cursor" } } } },
  { name: "create_batch", description: "Create a new batch under a product.", inputSchema: { type: "object", required: ["product_id", "name"], properties: { product_id: { type: "string", description: "Product ID" }, name: { type: "string", description: "Batch name/number e.g. 122825" }, quantity: { type: "number", description: "Initial quantity" }, location_id: { type: "string", description: "Location ID" } } } },
  { name: "get_adjustments", description: "Get stock adjustment history.", inputSchema: { type: "object", properties: { batch_id: { type: "string", description: "Filter by batch ID" }, product_id: { type: "string", description: "Filter by product ID" }, first: { type: "number", description: "Page size (default 20)" } } } },
  { name: "insert_stock_adjustment", description: "Adjust inventory on a batch. Positive quantity adds stock, negative removes. ALWAYS confirm with Nick in chat before calling this.", inputSchema: { type: "object", required: ["batch_id", "quantity", "reason"], properties: { batch_id: { type: "string", description: "Batch ID to adjust" }, quantity: { type: "number", description: "Amount to add (positive) or remove (negative)" }, reason: { type: "string", enum: ["physical_count","waste","sample","theft","damage","return","other"] }, note: { type: "string", description: "Audit trail note" }, location_id: { type: "string", description: "Location ID" } } } },
  { name: "get_locations", description: "List all locations in Distru.", inputSchema: { type: "object", properties: {} } },
  { name: "get_contacts", description: "List dispensary contacts and customers.", inputSchema: { type: "object", properties: { search: { type: "string", description: "Search by name" }, first: { type: "number", description: "Page size (default 40)" }, after: { type: "string", description: "Pagination cursor" } } } },
  { name: "get_orders", description: "List sales orders.", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["draft","pending","confirmed","invoiced","complete","cancelled"] }, contact_id: { type: "string", description: "Filter by dispensary contact ID" }, first: { type: "number", description: "Page size (default 20)" }, after: { type: "string", description: "Pagination cursor" } } } },
  { name: "get_order", description: "Get one order with full line item details.", inputSchema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string", description: "Order ID" } } } },
  { name: "get_strains", description: "List all strains configured in Distru.", inputSchema: { type: "object", properties: { search: { type: "string", description: "Search by strain name" } } } },
  { name: "get_packages", description: "List Metrc packages (compliance-tracked inventory).", inputSchema: { type: "object", properties: { product_id: { type: "string", description: "Filter by product ID" }, first: { type: "number", description: "Page size (default 20)" } } } },
  { name: "upsert_product", description: "Create or update a product. Pass id to update existing.", inputSchema: { type: "object", required: ["name"], properties: { id: { type: "string", description: "Product ID (omit to create new)" }, name: { type: "string", description: "Product name" }, sku: { type: "string", description: "SKU code" }, unit_price: { type: "number", description: "Wholesale price per unit" }, units_per_case: { type: "number", description: "Units per case" }, is_active: { type: "boolean", description: "Active status" } } } }
];

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case "get_inventory":           return await distru(`/inventory${qs(a)}`);
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

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  if (!SERVER_SECRET) return next();
  const token = req.query.key || req.headers["x-api-key"];
  if (token !== SERVER_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "distru-mcp", ts: new Date().toISOString() })
);

const sessions = {};

app.get("/sse", auth, async (req, res) => {
  const mcpSrv = buildMcpServer();
  const transport = new SSEServerTransport("/messages", res);
  sessions[transport.sessionId] = transport;
  res.on("close", () => delete sessions[transport.sessionId]);
  await mcpSrv.connect(transport);
});

app.post("/messages", auth, async (req, res) => {
  const t = sessions[req.query.sessionId];
  if (!t) return res.status(404).json({ error: "Session not found — reconnect to /sse" });
  await t.handlePostMessage(req, res);
});

app.listen(PORT, () => console.log(`Distru MCP ready on :${PORT}`));
