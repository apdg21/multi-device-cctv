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
// streamers: streamId -> { ws, viewers: Map(viewerId -> ws), createdAt }
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

wss.on('connection', function connection(ws) {
  // metadata stored on ws for routing convenience
  ws._meta = { role: null, streamId: null, viewerId: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn('Invalid JSON received:', raw);
      return;
    }

    const { type } = msg;

    // Identify: set role and register in our maps
    if (type === 'identify') {
      const { role, streamId: msgStreamId, viewerId: msgViewerId } = msg;
      ws._meta.role = role;

      if (role === 'streamer') {
        // If the client supplied a streamId, reuse it, otherwise create one.
        const id = msgStreamId || uuidv4();
        ws._meta.streamId = id;
        // register streamer
        streamers.set(id, { ws, viewers: new Map(), createdAt: Date.now() });
        console.log(`Streamer connected for streamId=${id}`);
        send(ws, { type: 'identified', role: 'streamer', streamId: id });
      } else if (role === 'viewer') {
        // viewer must provide streamId to join
        const streamId = msgStreamId;
        if (!streamId) {
          send(ws, { type: 'error', message: 'viewer must provide streamId' });
          return;
        }
        ws._meta.streamId = streamId;
        ws._meta.viewerId = msgViewerId || uuidv4();

        const streamerEntry = streamers.get(streamId);
        if (!streamerEntry || !streamerEntry.ws || streamerEntry.ws.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'no-stream', message: 'Streamer not available' });
          console.log(`Viewer attempted join but no streamer for streamId=${streamId}`);
          return;
        }

        // register viewer in streamer's viewers
        streamerEntry.viewers.set(ws._meta.viewerId, ws);
        console.log(`Viewer ${ws._meta.viewerId} joined stream ${streamId}`);

        // Notify streamer that a viewer joined so it can create an offer for that viewer
        send(streamerEntry.ws, { type: 'viewer-joined', viewerId: ws._meta.viewerId });

        // Ack viewer with assigned viewerId and streamId
        send(ws, { type: 'identified', role: 'viewer', streamId, viewerId: ws._meta.viewerId });
      }
      return;
    }

    // All other types: offer/answer/candidate/leave - forwarding/routing logic
    if (type === 'offer' || type === 'answer' || type === 'candidate' || type === 'leave') {
      // Determine canonical streamId: prefer connection metadata, fall back to message
      const originRole = ws._meta && ws._meta.role ? ws._meta.role : (msg.fromRole || 'unknown');
      const canonicalStreamId = ws._meta.streamId || msg.streamId || msg.streamIdFrom || null;

      // If this message is meant for a specific viewer inside a stream:
      if (msg.to && msg.toViewer === true) {
        // streamId must be known to find the target viewer
        const streamId = canonicalStreamId || msg.streamId;
        if (!streamId) {
          console.warn('Routing to viewer requested but no streamId available on message or connection', { msg, originRole });
          return;
        }
        const streamerEntry = streamers.get(streamId);
        if (!streamerEntry) {
          console.warn('No streamer found for routing to viewer', streamId);
          return;
        }
        const viewerId = msg.to;
        const viewerWs = streamerEntry.viewers.get(viewerId);
        if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
          // Ensure forwarded message contains streamId so viewer can know origin stream (helpful for debugging)
          const forwardMsg = Object.assign({}, msg, { streamId });
          send(viewerWs, forwardMsg);
          // logging
          console.log(`Routed ${type} -> viewer ${viewerId} (stream=${streamId})`);
        } else {
          console.warn('Viewer ws not found/open for viewerId', viewerId, 'in stream', streamId);
        }
        return;
      }

      // If message should go to the streamer (viewer -> streamer), typically msg.toStreamer===true and 'to' is streamId or omitted
      if (msg.toStreamer === true) {
        // src viewer's connection should include streamId; fallback to msg.to
        const streamId = canonicalStreamId || msg.to || msg.streamId;
        if (!streamId) {
          console.warn('Routing to streamer requested but no streamId available', { msg, originRole });
          return;
        }
        const streamerEntry = streamers.get(streamId);
        if (streamerEntry && streamerEntry.ws && streamerEntry.ws.readyState === WebSocket.OPEN) {
          // Attach from info if not present
          const from = msg.from || ws._meta.viewerId || msg.viewerId || null;
          const forwardMsg = Object.assign({}, msg, { streamId, from });
          send(streamerEntry.ws, forwardMsg);
          console.log(`Routed ${type} -> streamer (stream=${streamId}) from viewer ${from || 'unknown'}`);
        } else {
          console.warn('Streamer not found/open for streamId', streamId);
        }
        return;
      }

      // If message is from a streamer and intended for a viewer but msg.toViewer flag omitted,
      // attempt to route by interpreting 'to' as viewerId and using streamer's meta streamId.
      if (originRole === 'streamer' && msg.to && !msg.toStreamer) {
        const streamId = canonicalStreamId;
        const streamerEntry = streamers.get(streamId);
        if (!streamerEntry) {
          console.warn('Streamer-origin message but stream entry missing for streamId', streamId, 'msg:', msg);
          return;
        }
        const viewerWs = streamerEntry.viewers.get(msg.to);
        if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
          const forwardMsg = Object.assign({}, msg, { streamId });
          send(viewerWs, forwardMsg);
          console.log(`(heuristic) Routed ${type} from streamer -> viewer ${msg.to} (stream=${streamId})`);
          return;
        } else {
          console.warn('(heuristic) Viewer ws not found/open for viewerId', msg.to, 'in stream', streamId);
          return;
        }
      }

      // If message is from a viewer and contained 'to' but no toStreamer flag, assume it's for streamer
      if (originRole === 'viewer' && !msg.toViewer) {
        const streamId = canonicalStreamId;
        if (!streamId) {
          console.warn('Viewer-origin message but no streamId on connection or message', msg);
          return;
        }
        const streamerEntry = streamers.get(streamId);
        if (streamerEntry && streamerEntry.ws && streamerEntry.ws.readyState === WebSocket.OPEN) {
          const forwardMsg = Object.assign({}, msg, { streamId });
          send(streamerEntry.ws, forwardMsg);
          console.log(`(heuristic) Routed ${type} from viewer -> streamer (stream=${streamId})`);
        } else {
          console.warn('(heuristic) streamer not found/open for streamId', streamId);
        }
        return;
      }

      // Fallback: we don't know how to route this message
      console.warn('Unhandled routing for message (missing flags / unknown origin). Message:', msg, 'originRole:', originRole);
      return;
    }

    console.warn('Unknown message type:', type);
  });

  ws.on('close', () => {
    const meta = ws._meta;
    if (!meta || !meta.role) return;

    if (meta.role === 'streamer') {
      const streamId = meta.streamId;
      const entry = streamers.get(streamId);
      if (entry) {
        for (const [vid, vws] of entry.viewers.entries()) {
          send(vws, { type: 'stream-ended', streamId });
          try { vws.close(); } catch (_) {}
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
        // notify streamer that viewer left so it can cleanup per-viewer resources
        send(entry.ws, { type: 'viewer-left', viewerId });
        console.log(`Viewer ${viewerId} disconnected from stream ${streamId}`);
      }
    }
  });
});

// Periodic cleanup: remove any streamer whose ws is closed
setInterval(() => {
  for (const [streamId, entry] of streamers.entries()) {
    if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
      entry.viewers.forEach((vws) => send(vws, { type: 'stream-ended', streamId }));
      streamers.delete(streamId);
      console.log('Cleaned up streamer', streamId);
    }
  }
}, 30_000);

// Serve convenience pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'streamer.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log('Open /streamer.html to start a stream or /viewer.html?stream=<id> to view');
});
