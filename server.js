// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// In-memory maps:
// streamers: streamId -> { ws, viewers: Map(viewerId -> ws) }
const streamers = new Map();

// Simple helper to send JSON via ws
function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to send ws message', e);
  }
}

// Message types:
// { type: 'identify', role: 'streamer'|'viewer', streamId, viewerId(optional) }
// { type: 'viewer-joined', viewerId } (server -> streamer)
// { type: 'offer', from: viewerId, to: streamId, sdp } (streamer -> viewer) -- actually streamer sends offer to server destined for viewer
// { type: 'answer', from: viewerId, to: streamId, sdp } (viewer -> streamer via server)
// { type: 'candidate', from, to, candidate } (bidirectional)
// { type: 'leave', viewerId } (viewer leaves)

// WebSocket connection handler
wss.on('connection', function connection(ws) {
  ws._meta = { role: null, streamId: null, viewerId: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn('Invalid JSON', raw);
      return;
    }

    const { type } = msg;

    if (type === 'identify') {
      const { role, streamId, viewerId } = msg;
      ws._meta.role = role;

      if (role === 'streamer') {
        // If no streamId provided, create one
        const id = streamId || uuidv4();
        ws._meta.streamId = id;
        // Store streamer
        streamers.set(id, { ws, viewers: new Map(), createdAt: Date.now() });
        console.log(`Streamer connected for streamId=${id}`);
        // Reply with streamId
        send(ws, { type: 'identified', role: 'streamer', streamId: id });
      } else if (role === 'viewer') {
        if (!streamId) {
          send(ws, { type: 'error', message: 'viewer must provide streamId' });
          return;
        }
        ws._meta.streamId = streamId;
        ws._meta.viewerId = viewerId || uuidv4();

        const streamerEntry = streamers.get(streamId);
        if (!streamerEntry || !streamerEntry.ws || streamerEntry.ws.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'no-stream', message: 'Streamer not available' });
          console.log(`Viewer attempted join but no streamer for streamId=${streamId}`);
          return;
        }

        // register viewer on streamer's entry
        streamerEntry.viewers.set(ws._meta.viewerId, ws);
        console.log(`Viewer ${ws._meta.viewerId} joined stream ${streamId}`);

        // Notify streamer a viewer joined (streamer will create Offer for that viewer)
        send(streamerEntry.ws, { type: 'viewer-joined', viewerId: ws._meta.viewerId });

        // Reply ack to viewer with its viewerId
        send(ws, { type: 'identified', role: 'viewer', streamId, viewerId: ws._meta.viewerId });
      }
      return;
    }

    // From streamer to viewer or vice-versa: forward
    if (type === 'offer' || type === 'answer' || type === 'candidate' || type === 'leave') {
      const { to, from } = msg;
      // if 'to' is a viewerId and the streamer is present, route to that viewer
      if (to && msg.toViewer === true) {
        // route to viewer inside a stream
        const streamId = msg.streamId;
        const streamerEntry = streamers.get(streamId);
        if (!streamerEntry) {
          console.warn('No streamer found for routing to viewer', streamId);
          return;
        }
        const viewerWs = streamerEntry.viewers.get(to);
        if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
          send(viewerWs, msg);
        } else {
          console.warn('Viewer ws not found/open for viewerId', to);
        }
        return;
      }

      // if 'to' is streamer (send to streamer by streamId)
      if (to && msg.toStreamer === true) {
        const streamId = to;
        const streamerEntry = streamers.get(streamId);
        if (streamerEntry && streamerEntry.ws && streamerEntry.ws.readyState === WebSocket.OPEN) {
          send(streamerEntry.ws, msg);
        } else {
          console.warn('Streamer not found/open for streamId', streamId);
        }
        return;
      }

      // fallback: broadcast to stream participants (rare)
      console.warn('Unhandled routing message', msg);
      return;
    }

    console.warn('Unknown message type:', type);
  });

  ws.on('close', () => {
    const meta = ws._meta;
    if (!meta || !meta.role) return;

    if (meta.role === 'streamer') {
      // remove streamer and notify viewers if any
      const streamId = meta.streamId;
      const entry = streamers.get(streamId);
      if (entry) {
        // notify all viewers that streamer left
        for (const [vid, vws] of entry.viewers.entries()) {
          send(vws, { type: 'stream-ended', streamId });
          try { vws.close(); } catch(_) {}
        }
        streamers.delete(streamId);
        console.log(`Streamer disconnected and removed streamId=${streamId}`);
      }
    } else if (meta.role === 'viewer') {
      const streamId = meta.streamId;
      const viewerId = meta.viewerId;
      const entry = streamers.get(streamId);
      if (entry) {
        entry.viewers.delete(viewerId);
        // notify streamer that viewer left so it can cleanup any per-viewer PC
        send(entry.ws, { type: 'viewer-left', viewerId });
        console.log(`Viewer ${viewerId} disconnected from stream ${streamId}`);
      }
    }
  });
});

// Lightweight cleanup loop to drop stale streamers (if desired)
setInterval(() => {
  const now = Date.now();
  for (const [streamId, entry] of streamers.entries()) {
    // if streamer ws closed, remove
    if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
      entry.viewers.forEach((vws) => send(vws, { type: 'stream-ended', streamId }));
      streamers.delete(streamId);
      console.log('Cleaned up streamer', streamId);
    }
  }
}, 30_000);

// Serve index for convenience
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'streamer.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log('Open /streamer.html to start a stream or /viewer.html?stream=<id> to view');
});
