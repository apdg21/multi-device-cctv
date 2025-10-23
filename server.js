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
  res.sendFile(path.join(__dirname, "public", "index.html"));
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

// Function to get the correct base URL
function getBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  if (process.env.NODE_ENV === 'production') {
    // In production, you might want to set this environment variable
    return process.env.BASE_URL || `http://localhost:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}

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
        const streamId = uuidv4(); // This generates a UNIQUE ID for each streamer
        ws.role = "streamer";
        ws.streamId = streamId;

        streams.set(streamId, { 
          streamer: ws, 
          viewers: new Map(),
          createdAt: new Date(),
          streamerId: ws.id
        });
        
        console.log(`🎥 New stream created: streamId=${streamId} by streamer=${ws.id}`);
        console.log(`📊 Active streams: ${streams.size}`);

        // Generate the viewer URL
        const baseUrl = getBaseUrl();
        const viewerUrl = `${baseUrl}/viewer.html?stream=${streamId}`;
        
        // Send back the unique link for viewers
        ws.send(
          JSON.stringify({
            type: "stream-info",
            streamId,
            viewerUrl: viewerUrl,
            message: "Share this private link with viewers"
          })
        );
        break;
      }

      // ---------------- Viewer joins ----------------
      case "viewer-join": {
        const { streamId } = data;
        const stream = streams.get(streamId);
        
        if (!stream) {
          ws.send(JSON.stringify({ 
            type: "error", 
            message: "Stream not found or has ended" 
          }));
          console.log(`❌ Viewer tried to join non-existent stream: ${streamId}`);
          ws.close();
          return;
        }

        // Check if streamer is still connected
        if (stream.streamer.readyState !== stream.streamer.OPEN) {
          ws.send(JSON.stringify({ 
            type: "error", 
            message: "Streamer has disconnected" 
          }));
          console.log(`❌ Viewer tried to join stream with disconnected streamer: ${streamId}`);
          streams.delete(streamId);
          ws.close();
          return;
        }

        ws.role = "viewer";
        ws.streamId = streamId;
        stream.viewers.set(ws.id, ws);

        console.log(`👁️ Viewer ${ws.id} joined stream ${streamId}`);
        console.log(`📊 Viewers in stream ${streamId}: ${stream.viewers.size}`);

        // Notify streamer that a viewer joined
        stream.streamer.send(
          JSON.stringify({
            type: "viewer-joined",
            viewerId: ws.id,
            viewerCount: stream.viewers.size
          })
        );
        
        // Send stream info to viewer
        ws.send(JSON.stringify({
          type: "stream-joined",
          streamId: streamId,
          streamerId: stream.streamerId
        }));
        break;
      }

      // ---------------- Streamer sends offer ----------------
      case "streamer-offer": {
        const stream = streams.get(ws.streamId);
        if (!stream) {
          console.warn(`No active stream found for offer from streamer ${ws.id}`);
          return;
        }

        console.log(`📤 Streamer ${ws.id} sending offer to ${stream.viewers.size} viewers`);
        
        for (const [vid, viewerWs] of stream.viewers.entries()) {
          if (viewerWs.readyState === viewerWs.OPEN) {
            viewerWs.send(JSON.stringify({ 
              type: "streamer-offer", 
              offer: data.offer 
            }));
            console.log(`➡️ Routed offer -> viewer ${vid}`);
          }
        }
        break;
      }

      // ---------------- Streamer ICE candidate ----------------
      case "streamer-candidate": {
        const stream = streams.get(ws.streamId);
        if (!stream) return;
        
        for (const [vid, viewerWs] of stream.viewers.entries()) {
          if (viewerWs.readyState === viewerWs.OPEN) {
            viewerWs.send(JSON.stringify({ 
              type: "streamer-candidate", 
              candidate: data.candidate 
            }));
          }
        }
        break;
      }

      // ---------------- Viewer sends answer ----------------
      case "viewer-answer": {
        const stream = streams.get(ws.streamId);
        if (!stream || !stream.streamer) return;
        
        if (stream.streamer.readyState === stream.streamer.OPEN) {
          stream.streamer.send(
            JSON.stringify({
              type: "viewer-answer",
              viewerId: ws.id,
              answer: data.answer,
            })
          );
          console.log(`⬅️ Routed answer -> streamer from viewer ${ws.id}`);
        }
        break;
      }

      // ---------------- Viewer ICE candidate ----------------
      case "viewer-candidate": {
        const stream = streams.get(ws.streamId);
        if (!stream || !stream.streamer) return;
        
        if (stream.streamer.readyState === stream.streamer.OPEN) {
          stream.streamer.send(
            JSON.stringify({
              type: "viewer-candidate",
              viewerId: ws.id,
              candidate: data.candidate,
            })
          );
        }
        break;
      }

      default:
        console.log("Unknown message type:", data.type);
    }
  });

  ws.on("close", () => {
    console.log(`🔴 WebSocket closed: ${ws.id} (role: ${ws.role})`);
    
    if (ws.role === "streamer" && ws.streamId) {
      const stream = streams.get(ws.streamId);
      if (stream) {
        // Notify all viewers that stream ended
        for (const [vid, viewerWs] of stream.viewers.entries()) {
          if (viewerWs.readyState === viewerWs.OPEN) {
            viewerWs.send(JSON.stringify({
              type: "stream-ended",
              message: "Streamer has disconnected"
            }));
            viewerWs.close();
          }
        }
        streams.delete(ws.streamId);
        console.log(`❌ Streamer disconnected, removed streamId=${ws.streamId}`);
        console.log(`📊 Remaining active streams: ${streams.size}`);
      }
    } else if (ws.role === "viewer" && ws.streamId) {
      const stream = streams.get(ws.streamId);
      if (stream) {
        stream.viewers.delete(ws.id);
        console.log(`👋 Viewer ${ws.id} disconnected from stream ${ws.streamId}`);
        console.log(`📊 Remaining viewers in stream: ${stream.viewers.size}`);
        
        // Notify streamer about viewer leaving
        if (stream.streamer.readyState === stream.streamer.OPEN) {
          stream.streamer.send(JSON.stringify({
            type: "viewer-left",
            viewerId: ws.id,
            viewerCount: stream.viewers.size
          }));
        }
      }
    }
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error for ${ws.id}:`, error);
  });
});

// Clean up dead streams periodically
setInterval(() => {
  let cleaned = 0;
  for (const [streamId, stream] of streams.entries()) {
    if (stream.streamer.readyState !== stream.streamer.OPEN) {
      streams.delete(streamId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} dead streams`);
  }
}, 30000); // Every 30 seconds

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📹 Streamer: http://localhost:${PORT}/streamer`);
  console.log(`👀 Viewer: http://localhost:${PORT}/viewer`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
  console.log(`🌐 Base URL: ${getBaseUrl()}`);
});
