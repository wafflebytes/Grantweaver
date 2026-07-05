import fs from 'fs';
import path from 'path';

// Helper to generate a unique ID
function uuid() {
  return Math.random().toString(36).substring(2, 12);
}

// Helper to generate random seeds for sketchy rendering
function seed() {
  return Math.floor(Math.random() * 1000000000);
}

const elements = [];

// Helper to create a container box (subgraph)
function createContainer(title, x, y, w, h, strokeColor) {
  const rectId = uuid();
  const textId = uuid();
  
  // Rectangle for subgraph
  elements.push({
    id: rectId,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "dashed",
    roughness: 1.5,
    opacity: 60,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: [{ id: textId, type: "text" }],
    updated: Date.now(),
    link: null,
    locked: false
  });

  // Text label for container
  elements.push({
    id: textId,
    type: "text",
    x: x + 20,
    y: y + 15,
    width: w - 40,
    height: 30,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text: title,
    fontSize: 18,
    fontFamily: 1, // Hand-drawn (Virgil)
    textAlign: "left",
    verticalAlign: "top",
    containerId: rectId,
    originalText: title
  });

  return rectId;
}

// Helper to create a system component node
function createNode(title, desc, x, y, w, h, strokeColor, bgColor) {
  const rectId = uuid();
  const textId = uuid();
  const textContent = `${title}\n${desc}`;

  // Rounded rectangle for node
  elements.push({
    id: rectId,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor,
    backgroundColor: bgColor,
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 1.2,
    opacity: 100,
    roundness: { type: 3 }, // Rounded corners
    seed: seed(),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: [{ id: textId, type: "text" }],
    updated: Date.now(),
    link: null,
    locked: false
  });

  // Label text
  elements.push({
    id: textId,
    type: "text",
    x: x + 10,
    y: y + 10,
    width: w - 20,
    height: h - 20,
    angle: 0,
    strokeColor: "#f8fafc",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text: textContent,
    fontSize: 14,
    fontFamily: 1, // Hand-drawn
    textAlign: "center",
    verticalAlign: "middle",
    containerId: rectId,
    originalText: textContent
  });

  return { id: rectId, x, y, width: w, height: h };
}

// Helper to draw clean straight arrows
function drawArrow(fromNode, toNode, label = "", arrowhead = "arrow") {
  const arrowId = uuid();
  
  // Calculate center coordinates
  const fromCenterX = fromNode.x + fromNode.width / 2;
  const fromCenterY = fromNode.y + fromNode.height / 2;
  const toCenterX = toNode.x + toNode.width / 2;
  const toCenterY = toNode.y + toNode.height / 2;

  let startX = fromCenterX;
  let startY = fromCenterY;
  let endX = toCenterX;
  let endY = toCenterY;

  // Simple bounding box intersection logic to snap points to borders
  if (Math.abs(toCenterX - fromCenterX) > Math.abs(toCenterY - fromCenterY)) {
    // Horizontal layout
    if (toCenterX > fromCenterX) {
      startX = fromNode.x + fromNode.width;
      endX = toNode.x;
    } else {
      startX = fromNode.x;
      endX = toNode.x + toNode.width;
    }
  } else {
    // Vertical layout
    if (toCenterY > fromCenterY) {
      startY = fromNode.y + fromNode.height;
      endY = toNode.y;
    } else {
      startY = fromNode.y;
      endY = toNode.y + toNode.height;
    }
  }

  const dx = endX - startX;
  const dy = endY - startY;

  elements.push({
    id: arrowId,
    type: "arrow",
    x: startX,
    y: startY,
    width: Math.abs(dx),
    height: Math.abs(dy),
    angle: 0,
    strokeColor: "#94a3b8",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1.5,
    strokeStyle: "solid",
    roughness: 1.2,
    opacity: 100,
    roundness: { type: 2 },
    seed: seed(),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    points: [[0, 0], [dx, dy]],
    lastCommittedPoint: null,
    startBinding: { elementId: fromNode.id, focus: 0, gap: 1 },
    endBinding: { elementId: toNode.id, focus: 0, gap: 1 },
    endArrowhead: arrowhead === "none" ? null : "arrow",
    startArrowhead: arrowhead === "both" ? "arrow" : null
  });

  // If there's a label, add a text element near the middle of the arrow
  if (label) {
    const textId = uuid();
    const midX = startX + dx / 2 - 40;
    const midY = startY + dy / 2 - 10;
    elements.push({
      id: textId,
      type: "text",
      x: midX,
      y: midY,
      width: 100,
      height: 20,
      angle: 0,
      strokeColor: "#94a3b8",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      roundness: null,
      seed: seed(),
      version: 1,
      versionNonce: 0,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      text: label,
      fontSize: 12,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: null,
      originalText: label
    });
  }
}

// 1. Create Bounding Columns (Excalidraw subgraphs)
createContainer("🌐 CLIENT INTERFACES", 30, 30, 320, 800, "#475569");
createContainer("🚂 GRANTWEAVER APP ENGINE", 410, 30, 340, 800, "#ca8a04");
createContainer("💾 SURFACES & DATA", 810, 30, 360, 1040, "#475569");

// Color Schemes (Dark Mode Fills)
const cSlack = { stroke: "#38bdf8", bg: "#0f172a" };  // Blue Slack
const cApp = { stroke: "#eab308", bg: "#1c1917" };    // Gold Engine
const cMcp = { stroke: "#c084fc", bg: "#1e1b4b" };    // Purple MCP
const cDb = { stroke: "#22c55e", bg: "#022c22" };     // Green DB
const cExt = { stroke: "#78716c", bg: "#18181b" };    // Gray External

// 2. Generate Nodes for Column 1: CLIENTS
const ext = createNode("🤖 Claude / Cursor", "HTTP + bearer auth API client", 60, 100, 260, 80, cExt.stroke, cExt.bg);
const dm = createNode("💬 Agent DM", "streamed replies · task timeline", 60, 260, 260, 80, cSlack.stroke, cSlack.bg);
const men = createNode("💬 @mentions", "in channel threads", 60, 420, 260, 80, cSlack.stroke, cSlack.bg);
const rx = createNode("🧵 reactions / shortcuts", "/grantweaver slash commands", 60, 580, 260, 80, cSlack.stroke, cSlack.bg);

// 3. Generate Nodes for Column 2: ENGINE
const verify = createNode("🛡️ Signature Verification", "Slack Secret / Bearer Auth validator", 450, 100, 260, 80, cApp.stroke, cApp.bg);
const router = createNode("⚡ Bolt.js Event Router", "routes events · actions · commands", 450, 220, 260, 80, cApp.stroke, cApp.bg);
const loop = createNode("🤖 Agent loop", "evidence prefetch → LLM reasoning loop", 450, 340, 260, 80, cApp.stroke, cApp.bg);
const tools = createNode("🛠️ Toolbelt", "8 modular orchestration tools", 450, 460, 260, 80, cApp.stroke, cApp.bg);
const cron = createNode("⏰ Scheduler & Sweeper", "watches · digests · memories", 450, 580, 260, 80, cApp.stroke, cApp.bg);
const obs = createNode("📊 Observability", "run tracker · latency · cost audit log", 450, 700, 260, 80, cApp.stroke, cApp.bg);

// 4. Generate Nodes for Column 3: DATA & SURFACES
const gw = createNode("grantweaver-mcp", "exposed MCP server · 6 tools", 860, 100, 260, 80, cMcp.stroke, cMcp.bg);
const gg = createNode("grantsgov-mcp", "consumed Grants.gov MCP server", 860, 220, 260, 80, cMcp.stroke, cMcp.bg);
const db = createNode("🗄️ Postgres DB", "pointers & metadata only (no content)", 860, 340, 260, 80, cDb.stroke, cDb.bg);
const web = createNode("🌐 Public Web Page", "/org/<token> evidence & marketing", 860, 460, 260, 80, cExt.stroke, cExt.bg);
const home = createNode("📊 App Home", "pipeline board · Impact Meter", 860, 580, 260, 80, cSlack.stroke, cSlack.bg);
const lists = createNode("📋 Slack Lists ×2", "Pipeline & Evidence Locker · slackLists.*", 860, 700, 260, 80, cSlack.stroke, cSlack.bg);
const canvas = createNode("📝 Canvases", "opportunity drafts · canvases.edit", 860, 820, 260, 80, cSlack.stroke, cSlack.bg);
const rts = createNode("🔍 Slack Workspace Search", "assistant.search.context RTS API", 860, 940, 260, 80, cSlack.stroke, cSlack.bg);

// External API Node on the far right
const gov = createNode("api.grants.gov", "Federal grants notices database", 1250, 220, 200, 80, cExt.stroke, cExt.bg);

// 5. Connect the Nodes with straight, beautiful arrows
drawArrow(ext, verify);
drawArrow(dm, verify);
drawArrow(men, verify);
drawArrow(rx, verify);

drawArrow(verify, router);
drawArrow(router, loop);
drawArrow(router, cron);
drawArrow(loop, tools);
drawArrow(loop, obs);

drawArrow(tools, rts);
drawArrow(tools, gg);
drawArrow(gg, gov);
drawArrow(tools, canvas);
drawArrow(tools, lists);
drawArrow(tools, db);
drawArrow(obs, db);

drawArrow(cron, lists, "", "both"); // Bidirectional
drawArrow(cron, db);

drawArrow(gw, db, "", "none");
drawArrow(home, db, "", "none");
drawArrow(web, db, "", "none");

// 6. Wrap in Excalidraw JSON Schema
const excalidrawContent = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    theme: "dark",
    viewBackgroundColor: "#121212",
    gridSize: 20,
    showGrid: true
  },
  files: {}
};

// Ensure directories exist and write file
const targetDir = path.resolve('/Users/chaitanya/grantweaver/assets');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}
const targetFile = path.join(targetDir, 'architecture.excalidraw');
fs.writeFileSync(targetFile, JSON.stringify(excalidrawContent, null, 2), 'utf-8');

console.log(`Generated Excalidraw diagram at: ${targetFile}`);
