/**
* SoundTouch Player — tiny local web server (Node/Express version)
* Plays a stream on Bose SoundTouch devices via UPnP AVTransport (port 8091).
*
* Flow per device:
*   1. POST UPnP SetAVTransportURI with the direct stream URL.
*   2. POST UPnP Play to start playback.
*
* Note: LOCAL_INTERNET_RADIO source (SoundTouch HTTP API) is not supported
* by firmware 27.x on SoundTouch 10. UPnP MediaRenderer works on all models.
*/
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const xmlEscape = (s) =>
  String(s).replaceAll(/[<>&"']/g, (c) =>
    ({ '<': '<', '>': '>', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])
  );

const bose = (ip, p) => `http://${ip}:8090${p}`;

async function postXml(ip, p, xml) {
  try {
    const url = bose(ip, p);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
      signal: AbortSignal.timeout(5000),
    });
    const result = { ok: r.ok, status: r.status };
    if (!r.ok) {
      result.device_response = (await r.text()).slice(0, 500);
      console.log(`Bose POST failed: ${url}`, result);
    }
    return result;
  } catch (err) {
    const result = err.name === 'TimeoutError' ? { ok: false, error: 'timeout' } : { ok: false, error: 'device unreachable' };
    console.log(`Bose POST error: ${bose(ip, p)}`, result, err.message);
    return result;
  }
}

const UPNP_PORT = 8091;
const UPNP_NS = 'urn:schemas-upnp-org:service:AVTransport:1';

function soapEnvelope(body) {
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

async function upnpAction(ip, action, innerXml) {
  const url = `http://${ip}:${UPNP_PORT}/AVTransport/Control`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${UPNP_NS}#${action}"`,
      },
      body: soapEnvelope(innerXml),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 400);
      console.log(`UPnP ${action} failed [${ip}]:`, r.status, text);
      return { ok: false, status: r.status, step: action };
    }
    return { ok: true };
  } catch (err) {
    const result = err.name === 'TimeoutError'
      ? { ok: false, error: 'timeout', step: action }
      : { ok: false, error: 'device unreachable', step: action };
    console.log(`UPnP ${action} error [${ip}]:`, err.message);
    return result;
  }
}

const setUriXml = (url) =>
  `<u:SetAVTransportURI xmlns:u="${UPNP_NS}">` +
  `<InstanceID>0</InstanceID>` +
  `<CurrentURI>${xmlEscape(url)}</CurrentURI>` +
  `<CurrentURIMetaData></CurrentURIMetaData>` +
  `</u:SetAVTransportURI>`;

const playXml = () =>
  `<u:Play xmlns:u="${UPNP_NS}"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>`;

async function play(ip, stream) {
  console.log(`\n━━ PLAY [${ip}] ${stream.name} ━━`);
  const r1 = await upnpAction(ip, 'SetAVTransportURI', setUriXml(stream.url));
  if (!r1.ok) return r1;
  const r2 = await upnpAction(ip, 'Play', playXml());
  if (!r2.ok) return r2;
  console.log(`  ✓ UPnP play sent to ${ip}`);
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
const enabledStreams = () => config.STREAMS.filter((s) => s.url);
const streamBySlot = (slot) => enabledStreams().find((s) => String(s.slot) === String(slot));

// Cache device MACs — needed for /setZone multiroom API.
const deviceIdCache = new Map();
async function fetchDeviceId(ip) {
  if (deviceIdCache.has(ip)) return deviceIdCache.get(ip);
  try {
    const r = await fetch(bose(ip, '/info'), { signal: AbortSignal.timeout(5000) });
    const m = /deviceID="([^"]+)"/.exec(await r.text());
    if (m) { deviceIdCache.set(ip, m[1]); return m[1]; }
  } catch {}
  return null;
}

async function playZone(stream) {
  const [master, ...slaves] = config.DEVICES;
  if (!slaves.length) return play(master.ip, stream);

  console.log(`\n━━ PLAY ZONE [${stream.name}] ━━`);

  // Resolve MACs in parallel — needed for /setZone.
  const [masterId, ...slaveIds] = await Promise.all(
    [master, ...slaves].map((d) => fetchDeviceId(d.ip))
  );
  if (!masterId) return { ok: false, error: 'master deviceID unavailable', step: 'fetchDeviceId' };

  const members = slaves
    .map((d, i) => (slaveIds[i] ? `<member ipaddress="${d.ip}">${slaveIds[i]}</member>` : null))
    .filter(Boolean)
    .join('');

  // Establish the zone BEFORE playing so slaves start syncing as soon as
  // the master's audio begins.
  const zoneResult = await postXml(master.ip, '/setZone', `<zone master="${masterId}">${members}</zone>`);
  if (!zoneResult.ok) return { ...zoneResult, step: 'setZone' };
  console.log('  ✓ zone established');

  // Play on master via UPnP — slaves sync to master's audio output automatically.
  return play(master.ip, stream);
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    streams: enabledStreams().map((s) => ({ slot: s.slot, name: s.name, logo: s.logo || null })),
    devices: config.DEVICES.map((d) => ({ id: d.id, name: d.name })),
  });
});

app.get('/play/:deviceId/:slot', async (req, res) => {
  const { deviceId, slot } = req.params;
  const stream = streamBySlot(slot);
  if (!stream) return res.status(404).json({ error: 'Unknown stream slot' });
  let results;
  if (deviceId === 'all') {
    results = { Zone: await playZone(stream) };
  } else {
    const device = deviceById(deviceId);
    if (!device) return res.status(404).json({ error: 'Unknown device' });
    results = { [device.name]: await play(device.ip, stream) };
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

// Diagnostic: proxy the device's /sources and /info responses so we can
// inspect firmware version and available source types without hitting the
// device API directly from the browser (CORS).
app.get('/diag/:deviceId', async (req, res) => {
  const device = deviceById(req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Unknown device' });
  const ip = device.ip;
  const get = async (endpoint) => {
    try {
      const r = await fetch(bose(ip, endpoint), { signal: AbortSignal.timeout(5000) });
      return { status: r.status, body: await r.text() };
    } catch (err) {
      return { error: err.message };
    }
  };
  const [sources, info, presets, nowPlaying] = await Promise.all([
    get('/sources'),
    get('/info'),
    get('/presets'),
    get('/now_playing'),
  ]);
  console.log(`\n━━ DIAG [${device.name} / ${ip}] ━━`);
  console.log('sources:', sources.body?.slice(0, 800));
  console.log('info:', info.body?.slice(0, 400));
  console.log('presets:', presets.body?.slice(0, 400));
  console.log('now_playing:', nowPlaying.body?.slice(0, 400));
  res.json({ sources, info, presets, nowPlaying });
});

// Serve the built Vue SPA in production
app.use(express.static(path.join(__dirname, 'dist')));

app.listen(config.PORT, config.HOST, () => {
  console.log(`\n  SoundTouch Player → http://localhost:${config.PORT}\n`);
});