import express from "express";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 10000;

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "streamer.html"));
});

// Serve streamer page
app.get("/streamer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "streamer.html"));
});

// Serve viewer page
app.get("/viewer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", streams: streams.size });
});

console.log("🎥 SecureCam signaling server starting...");

// Memory store: { streamId: { streamer: ws, viewers: Map<viewerId, ws> } }
const streams = new Map();

wss.on("connection", (ws) => {
  ws.id = uuidv4();
  ws.role = null;
  ws.streamId = null;

  console.log("🟢 New WebSocket connection:", ws.id);

  ws.on("message", async (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return console.warn("Invalid message:", message);
    }

    switch (data.type) {
      // ---------------- Streamer joins ----------------
      case "streamer-join": {
        const streamId = uuidv4();
        ws.role = "streamer";
        ws.streamId = streamId;

        streams.set(streamId, { streamer: ws, viewers: new Map() });
        console.log(`🎥 Streamer connected for streamId=${streamId}`);

        // Send back the unique link for viewers
        ws.send(
          JSON.stringify({
            type: "stream-info",
            streamId,
            viewerUrl: `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/viewer.html?stream=${streamId}`,
          })
        );
        break;
      }

      // ---------------- Viewer joins ----------------
      case "viewer-join": {
        const { streamId } = data;
        const stream = streams.get(streamId);
        if (!stream) {
          ws.send(JSON.stringify({ type: "error", message: "Stream not found" }));
          console.log(`❌ Viewer tried to join non-existent stream: ${streamId}`);
          return;
        }

        ws.role = "viewer";
        ws.streamId = streamId;
        stream.viewers.set(ws.id, ws);

        console.log(`👁️ Viewer ${ws.id} joined stream ${streamId}`);

        // Notify streamer that a viewer joined
        stream.streamer.send(
          JSON.stringify({
            type: "viewer-joined",
            viewerId: ws.id,
          })
        );
        break;
      }

      // ---------------- Streamer sends offer ----------------
      case "streamer-offer": {
        const stream = Array.from(streams.values()).find(s => s.streamer === ws);
        if (!stream) return console.warn("No active stream found for offer");

        for (const [vid, viewerWs] of stream.viewers.entries()) {
          viewerWs.send(JSON.stringify({ type: "streamer-offer", offer: data.offer }));
          console.log(`➡️ Routed offer -> viewer ${vid} (stream=${ws.streamId})`);
        }
        break;
      }

      // ---------------- Streamer ICE candidate ----------------
      case "streamer-candidate": {
        const stream = Array.from(streams.values()).find(s => s.streamer === ws);
        if (!stream) return;
        for (const [vid, viewerWs] of stream.viewers.entries()) {
          viewerWs.send(JSON.stringify({ type: "streamer-candidate", candidate: data.candidate }));
        }
        break;
      }

      // ---------------- Viewer sends answer ----------------
      case "viewer-answer": {
        const stream = streams.get(ws.streamId);
        if (!stream || !stream.streamer) return;
        stream.streamer.send(
          JSON.stringify({
            type: "viewer-answer",
            viewerId: ws.id,
            answer: data.answer,
          })
        );
        console.log(`⬅️ Routed answer -> streamer (stream=${ws.streamId}) from viewer ${ws.id}`);
        break;
      }

      // ---------------- Viewer ICE candidate ----------------
      case "viewer-candidate": {
        const stream = streams.get(ws.streamId);
        if (!stream || !stream.streamer) return;
        stream.streamer.send(
          JSON.stringify({
            type: "viewer-candidate",
            viewerId: ws.id,
            candidate: data.candidate,
          })
        );
        break;
      }

      default:
        console.log("Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    if (ws.role === "streamer" && ws.streamId) {
      streams.delete(ws.streamId);
      console.log(`❌ Streamer disconnected, removed streamId=${ws.streamId}`);
    } else if (ws.role === "viewer" && ws.streamId) {
      const stream = streams.get(ws.streamId);
      if (stream) {
        stream.viewers.delete(ws.id);
        console.log(`👋 Viewer ${ws.id} disconnected from stream ${ws.streamId}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📹 Streamer: http://localhost:${PORT}/streamer`);
  console.log(`👀 Viewer: http://localhost:${PORT}/viewer`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
});
