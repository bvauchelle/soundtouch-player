/**
 * SoundTouch Player — tiny local web server (Node/Express version)
 * Plays a stream on Bose SoundTouch devices via the local-network REST API,
 * using LOCAL_INTERNET_RADIO (works without Bose cloud).
 *
 * Flow per device:
 *   1. Device fetches /station.json from this server (LAN IP, not localhost).
 *   2. We POST /storePreset to write that JSON URL into a preset slot.
 *   3. We POST /key PRESET_N to play it immediately.
 */
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const xmlEscape = (s) =>
  String(s).replaceAll(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])
  );

function localIp() {
  if (config.SERVER_IP && config.SERVER_IP !== '192.168.1.X') return config.SERVER_IP;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

const bose = (ip, p) => `http://${ip}:8090${p}`;

async function postXml(ip, p, xml) {
  try {
    const r = await fetch(bose(ip, p), {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
      signal: AbortSignal.timeout(5000),
    });
    const result = { ok: r.ok, status: r.status };
    if (!r.ok) result.device_response = (await r.text()).slice(0, 500);
    return result;
  } catch (err) {
    if (err.name === 'TimeoutError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'device unreachable' };
  }
}

async function play(ip) {
  const jsonUrl = `http://${localIp()}:${config.PORT}/station.json`;
  const slot = config.PRESET_SLOT;
  const presetKey = `PRESET_${slot}`;

  // Step 1 — write the station into the chosen preset slot
  const storeXml =
    `<preset id="${slot}">` +
    `<ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" location="${xmlEscape(jsonUrl)}">` +
    `<itemName>${xmlEscape(config.STATION_NAME)}</itemName>` +
    `</ContentItem>` +
    `</preset>`;

  let result = await postXml(ip, '/storePreset', storeXml);
  if (!result.ok) return { ...result, step: 'storePreset' };

  // Step 2 — press + release the preset key to start playback
  for (const state of ['press', 'release']) {
    result = await postXml(ip, '/key', `<key state="${state}" sender="Gabbo">${presetKey}</key>`);
    if (!result.ok) return { ...result, step: `key ${state}` };
  }
  return { ok: true };
}

async function status(ip) {
  try {
    const r = await fetch(bose(ip, '/now_playing'), { signal: AbortSignal.timeout(5000) });
    return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 1000) };
  } catch (err) {
    if (err.name === 'TimeoutError') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'device unreachable' };
  }
}

async function nowPlaying(ip) {
  try {
    const r = await fetch(bose(ip, '/now_playing'), { signal: AbortSignal.timeout(3000) });
    const xml = await r.text();
    const source = /source="([^"]+)"/.exec(xml)?.[1] ?? 'UNKNOWN';
    const playStatus = /<playStatus>([^<]+)<\/playStatus>/.exec(xml)?.[1] ?? null;
    const playing = source !== 'STANDBY' && playStatus === 'PLAY_STATE';
    return { ok: true, playing, source };
  } catch (err) {
    return { ok: false, playing: false, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

async function getVolume(ip) {
  try {
    const r = await fetch(bose(ip, '/volume'), { signal: AbortSignal.timeout(3000) });
    const m = /<actualvolume>(\d+)<\/actualvolume>/.exec(await r.text());
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function setDeviceVolume(ip, level) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  return postXml(ip, '/volume', `<volume>${clamped}</volume>`);
}

// POWER is a toggle on SoundTouch: pressing it on a playing device puts it in
// standby; pressing on a stopped device wakes it. We check state first so /stop
// is idempotent — never accidentally turn a stopped device back on.
async function stopDevice(ip) {
  const np = await nowPlaying(ip);
  if (!np.ok) return np;
  if (!np.playing) return { ok: true, alreadyStopped: true };

  for (const state of ['press', 'release']) {
    const r = await postXml(ip, '/key', `<key state="${state}" sender="Gabbo">POWER</key>`);
    if (!r.ok) return { ...r, step: `key ${state}` };
  }
  return { ok: true };
}

const deviceById = (id) => config.DEVICES.find((d) => d.id === id);

// Bose multi-room sync: cache each device's deviceID (MAC) — needed for /setZone.
const deviceIdCache = new Map();
async function fetchDeviceId(ip) {
  if (deviceIdCache.has(ip)) return deviceIdCache.get(ip);
  try {
    const r = await fetch(bose(ip, '/info'), { signal: AbortSignal.timeout(5000) });
    const m = /deviceID="([^"]+)"/.exec(await r.text());
    if (m) {
      deviceIdCache.set(ip, m[1]);
      return m[1];
    }
  } catch {}
  return null;
}

async function playZone() {
  const [master, ...slaves] = config.DEVICES;

  // Solo case: just play.
  if (!slaves.length) return play(master.ip);

  // Resolve deviceIDs for everyone in the zone.
  const masterId = await fetchDeviceId(master.ip);
  if (!masterId) return { ok: false, error: 'master deviceID unavailable', step: 'fetchDeviceId' };

  const members = [];
  for (const s of slaves) {
    const id = await fetchDeviceId(s.ip);
    if (id) members.push(`<member ipaddress="${s.ip}">${id}</member>`);
  }

  // Set up the zone first — slaves listen for the master's stream as soon as it starts.
  const zoneXml = `<zone master="${masterId}">${members.join('')}</zone>`;
  const zoneResult = await postXml(master.ip, '/setZone', zoneXml);
  if (!zoneResult.ok) return { ...zoneResult, step: 'setZone' };

  // Now start playback on the master — slaves auto-sync.
  const playResult = await play(master.ip);
  if (!playResult.ok) return { ...playResult, step: 'play' };

  return { ok: true };
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/station.json', (_req, res) => {
  res.json({
    audio: { hasPlaylist: false, isRealtime: true, streamUrl: config.STREAM_URL },
    imageUrl: '',
    name: config.STATION_NAME,
    streamType: 'liveRadio',
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    streamUrl: config.STREAM_URL,
    stationName: config.STATION_NAME,
    logoUrl: config.LOGO_URL || null,
    devices: config.DEVICES.map((d) => ({ id: d.id, name: d.name })),
  });
});

app.get('/play/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  let results;
  if (deviceId === 'all') {
    results = { Zone: await playZone() };
  } else {
    const device = deviceById(deviceId);
    if (!device) return res.status(404).json({ error: 'Unknown device' });
    results = { [device.name]: await play(device.ip) };
  }
  const overall = Object.values(results).every((r) => r.ok);
  res.status(overall ? 200 : 502).json({ success: overall, results });
});

app.get('/stop/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  let results;
  if (deviceId === 'all') {
    const entries = await Promise.all(
      config.DEVICES.map(async (d) => [d.name, await stopDevice(d.ip)])
    );
    results = Object.fromEntries(entries);
  } else {
    const device = deviceById(deviceId);
    if (!device) return res.status(404).json({ error: 'Unknown device' });
    results = { [device.name]: await stopDevice(device.ip) };
  }
  const overall = Object.values(results).every((r) => r.ok);
  res.status(overall ? 200 : 502).json({ success: overall, results });
});

app.get('/state', async (_req, res) => {
  const entries = await Promise.all(
    config.DEVICES.map(async (d) => {
      const [np, volume] = await Promise.all([nowPlaying(d.ip), getVolume(d.ip)]);
      return [d.id, { ...np, volume }];
    })
  );
  res.json(Object.fromEntries(entries));
});

app.get('/volume/:deviceId/:level', async (req, res) => {
  const device = deviceById(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Unknown device' });
  const result = await setDeviceVolume(device.ip, req.params.level);
  res.status(result.ok ? 200 : 502).json(result);
});

app.get('/status/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  let results;
  if (deviceId === 'all') {
    const entries = await Promise.all(
      config.DEVICES.map(async (d) => [d.name, await status(d.ip)])
    );
    results = Object.fromEntries(entries);
  } else {
    const device = deviceById(deviceId);
    if (!device) return res.status(404).json({ error: 'Unknown device' });
    results = { [device.name]: await status(device.ip) };
  }
  res.json(results);
});

// Serve the built Vue SPA in production
app.use(express.static(path.join(__dirname, 'dist')));

app.listen(config.PORT, config.HOST, () => {
  console.log(`\n  SoundTouch Player → http://localhost:${config.PORT}`);
  console.log(`  station.json      → http://${localIp()}:${config.PORT}/station.json\n`);
});
