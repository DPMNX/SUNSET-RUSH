import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || '0.0.0.0';
const maxRacers = 4;
const laps = 3;
const TRACK_LENGTHS = { sunset: 1140, apex: 5300, pacific: 5300 };
const TRACK_NAMES = {
  sunset: 'Sunset Circuit',
  apex: 'Circuit of the Americas',
  pacific: 'Interlagos',
};
const WEATHER_NAMES = { neon: 'Neon', sunny: 'Sunny', rain: 'Rain' };
const safeTrack = (value) => (Object.hasOwn(TRACK_LENGTHS, value) ? value : 'sunset');
const safeWeather = (value) => (Object.hasOwn(WEATHER_NAMES, value) ? value : 'neon');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    pathname = '/';
  }
  if (pathname === '/') {
    const singleFile = path.join(root, 'SUNSET_RUSH.html');
    pathname = fs.existsSync(singleFile) ? '/SUNSET_RUSH.html' : '/index.html';
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  const relative = pathname.replace(/^[/\\]+/, '');
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Online rooms. The server is intentionally lightweight: each client owns its
// own car simulation and broadcasts a compact state snapshot at ~20 Hz.
// ---------------------------------------------------------------------------
const rooms = new Map();
let nextPlayerId = 1;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRoomCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function safeName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16);
  return name || 'RACER';
}

function safeCar(value) {
  const car = Number(value);
  return Number.isInteger(car) && car >= 0 && car < 6 ? car : 0;
}

function send(ws, payload) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {}
}

function broadcast(room, payload, exceptId = null) {
  for (const player of room.players.values()) {
    if (player.id === exceptId) continue;
    send(player.ws, payload);
  }
}

function roomPayload(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    max: maxRacers,
    laps,
    track: room.track,
    weather: room.weather,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      carId: p.carId,
      ready: p.ready,
      slot: p.slot,
      finishTime: p.finishTime,
    })),
  };
}

function broadcastRoom(room) {
  broadcast(room, { type: 'room', room: roomPayload(room) });
}

function finishRoomIfComplete(room) {
  if (room.phase !== 'racing') return false;
  const everyone = [...room.players.values()].every((p) => p.finishTime !== null);
  if (!everyone || room.players.size === 0) return false;
  room.phase = 'results';
  const results = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, time: p.finishTime }))
    .sort((a, b) => a.time - b.time);
  broadcast(room, { type: 'raceOver', results });
  return true;
}

function startRoomRace(room) {
  let slot = 0;
  for (const p of room.players.values()) {
    p.slot = slot++;
    p.finishTime = null;
    p.state = null;
    p.validLap = -1;
    p.lapDistance = 0;
    p.lastProgress = null;
  }
  room.phase = 'racing';
  room.startAt = Date.now() + 4500;
  broadcast(room, {
    type: 'race',
    startAt: room.startAt,
    laps,
    track: room.track,
    trackName: TRACK_NAMES[room.track],
    trackLength: TRACK_LENGTHS[room.track],
    weather: room.weather,
    weatherName: WEATHER_NAMES[room.weather],
    racers: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      carId: p.carId,
      slot: p.slot,
    })),
  });
}

function removeFromRoom(ws) {
  const player = ws._player;
  if (!player || !player.roomCode) return;
  const room = rooms.get(player.roomCode);
  player.roomCode = null;
  if (!room) return;
  room.players.delete(player.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
  broadcast(room, { type: 'left', id: player.id, name: player.name });
  finishRoomIfComplete(room);
  broadcastRoom(room);
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

wss.on('connection', (ws) => {
  const player = {
    id: nextPlayerId++,
    ws,
    name: 'RACER',
    carId: 0,
    roomCode: null,
    ready: false,
    slot: 0,
    finishTime: null,
    lastStateAt: 0,
    state: null,
    validLap: -1,
    lapDistance: 0,
    lastProgress: null,
  };
  ws._player = player;
  ws.isAlive = true;
  send(ws, { type: 'welcome', id: player.id });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    if (raw.length > 8192) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const room = player.roomCode ? rooms.get(player.roomCode) : null;

    if (msg.type === 'create') {
      if (room) {
        send(ws, { type: 'error', message: 'Leave your current room first.' });
        return;
      }
      player.name = safeName(msg.name);
      player.carId = safeCar(msg.carId);
      player.ready = false;
      player.finishTime = null;
      player.slot = 0;
      const code = makeRoomCode();
      const newRoom = {
        code,
        phase: 'lobby',
        hostId: player.id,
        track: safeTrack(msg.track),
        weather: safeWeather(msg.weather),
        players: new Map(),
        startAt: 0,
      };
      newRoom.players.set(player.id, player);
      rooms.set(code, newRoom);
      player.roomCode = code;
      broadcastRoom(newRoom);
      return;
    }

    if (msg.type === 'join') {
      if (room) {
        send(ws, { type: 'error', message: 'Leave your current room first.' });
        return;
      }
      const code = String(msg.code || '').trim().toUpperCase();
      const target = rooms.get(code);
      if (!target) {
        send(ws, { type: 'error', message: 'Room not found.' });
        return;
      }
      if (target.phase !== 'lobby') {
        send(ws, { type: 'error', message: 'That race is already in progress.' });
        return;
      }
      if (target.players.size >= maxRacers) {
        send(ws, { type: 'error', message: 'That room is full.' });
        return;
      }
      player.name = safeName(msg.name);
      player.carId = safeCar(msg.carId);
      player.ready = false;
      player.finishTime = null;
      player.slot = target.players.size;
      target.players.set(player.id, player);
      player.roomCode = code;
      broadcastRoom(target);
      return;
    }

    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t ?? Date.now(), serverTime: Date.now() });
      return;
    }

    if (msg.type === 'inspect') {
      const code = String(msg.code || '').trim().toUpperCase();
      const target = rooms.get(code);
      if (!target) {
        send(ws, { type: 'roomInfo', code, found: false });
        return;
      }
      send(ws, {
        type: 'roomInfo',
        code: target.code,
        found: true,
        track: target.track,
        weather: target.weather,
        phase: target.phase,
        players: target.players.size,
        max: maxRacers,
      });
      return;
    }

    if (!room) {
      send(ws, { type: 'error', message: 'Join a room first.' });
      return;
    }
    const roomPlayer = room.players.get(player.id);
    if (!roomPlayer) return;

    if (msg.type === 'car') {
      if (room.phase !== 'lobby') return;
      player.carId = safeCar(msg.carId);
      player.ready = false;
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'ready') {
      if (room.phase !== 'lobby') return;
      player.ready = !!msg.ready;
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'start') {
      if (room.hostId !== player.id) {
        send(ws, { type: 'error', message: 'Only the host can start.' });
        return;
      }
      if (room.phase !== 'lobby') return;
      const waiting = [...room.players.values()].filter((p) => p.id !== room.hostId && !p.ready);
      if (waiting.length) {
        send(ws, { type: 'error', message: `Waiting for ${waiting.map((p) => p.name).join(', ')} to ready up.` });
        return;
      }
      startRoomRace(room);
      return;
    }

    if (msg.type === 'rematch') {
      if (room.phase !== 'results') return;
      if (room.hostId !== player.id) {
        send(ws, { type: 'error', message: 'Only the host can start the next race.' });
        return;
      }
      startRoomRace(room);
      return;
    }

    if (msg.type === 'state') {
      if (room.phase !== 'racing' && room.phase !== 'results') return;
      const now = Date.now();
      if (now - player.lastStateAt < 30) return;
      player.lastStateAt = now;
      const s = msg.state;
      if (!s || typeof s !== 'object') return;
      const number = (value, min, max, fallback = 0) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
      };
      const optionalNumber = (value, min, max) => {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
      };
      const reportedLap = Math.round(number(s.lap, -1, 20, -1));
      const progress = number(s.progress, 0, 1);
      // Validate lap transitions server-side. A client cannot gain a lap by
      // reversing over the line and crossing forward again: at least 85% of
      // the circuit must have been covered in the forward direction first.
      if (player.lastProgress !== null) {
        let delta = progress - player.lastProgress;
        if (delta < -0.5) delta += 1;
        else if (delta > 0.5) delta -= 1;
        player.lapDistance = Math.max(0, player.lapDistance + delta);
      }
      const crossedGate = player.lastProgress !== null && player.lastProgress > 0.82 && progress < 0.18;
      if (player.validLap < 0) {
        if (crossedGate && reportedLap >= 0) {
          player.validLap = 0;
          player.lapDistance = 0;
        }
      } else if (
        crossedGate &&
        reportedLap > player.validLap &&
        player.lapDistance >= 0.85
      ) {
        player.validLap = Math.min(reportedLap, player.validLap + 1);
        player.lapDistance = 0;
      }
      player.lastProgress = progress;
      const state = {
        x: number(s.x, -5000, 5000),
        y: number(s.y, -20, 80),
        z: number(s.z, -5000, 5000),
        yaw: number(s.yaw, -Math.PI * 8, Math.PI * 8),
        speed: number(s.speed, -30, 140),
        steer: number(s.steer, -1, 1),
        lap: player.validLap,
        progress,
        finished: !!s.finished,
        finishTime: optionalNumber(s.finishTime, 0, 3600),
        bestLap: optionalNumber(s.bestLap, 0, 1200),
      };
      player.state = state;
      broadcast(room, { type: 'state', id: player.id, state }, player.id);
      return;
    }

    if (msg.type === 'finish') {
      if (room.phase !== 'racing') return;
      const time = Number(msg.time);
      if (!Number.isFinite(time) || time < 0) return;
      if (player.finishTime !== null) return;
      player.finishTime = Math.min(3600, time);
      broadcast(room, { type: 'finished', id: player.id, time: player.finishTime, name: player.name });
      finishRoomIfComplete(room);
      return;
    }

    if (msg.type === 'lobby') {
      if (room.hostId !== player.id) return;
      room.phase = 'lobby';
      room.startAt = 0;
      for (const p of room.players.values()) {
        p.ready = false;
        p.finishTime = null;
        p.slot = 0;
        p.state = null;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'leave') {
      removeFromRoom(ws);
      return;
    }

  });

  ws.on('close', () => removeFromRoom(ws));
  ws.on('error', () => removeFromRoom(ws));
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {}
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  }
}, 30000);

server.listen(port, host, () => {
  console.log(`SUNSET RUSH server: http://127.0.0.1:${port}`);
  console.log('Online rooms: create a room in-game, then share its 4-letter code.');
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        console.log(`LAN: http://${entry.address}:${port}`);
      }
    }
  }
  console.log('The offline single-player file still works without this server.');
});

process.on('SIGINT', () => {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
