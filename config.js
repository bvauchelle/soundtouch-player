// ── Configure your SoundTouch devices ─────────────────────────────────────
export default {
  DEVICES: [
    { id: 'device1', name: 'Séjour',  ip: '192.168.1.16' }, // SoundTouch 20
    { id: 'device2', name: 'Cuisine', ip: '192.168.1.17' }, // SoundTouch 10
  ],

  // ── Stream to play ──────────────────────────────────────────────────────────
  // Must be HTTP (not HTTPS) — SoundTouch firmware fetches it directly.
  STREAM_URL: 'http://icecast.radiofrance.fr/franceinter-hifi.aac',
  STATION_NAME: 'France Inter',

  // Optional station logo. Either a public URL or a path served by this app.
  // For a local file: drop it into the `public/` folder and reference it
  // by name (e.g. /logo.png for public/logo.png). Leave null to hide.
  LOGO_URL: '/france-inter.svg',

  // Preset slot used to store the station on each device (1–6).
  // 6 is least likely to overwrite something you care about.
  PRESET_SLOT: 1,

  // ── Web server ──────────────────────────────────────────────────────────────
  HOST: '0.0.0.0',
  PORT: 5010,

  // Set this to your NAS's fixed LAN IP when running inside Docker.
  // Leave as null to auto-detect (works when running directly on Windows).
  SERVER_IP: '192.168.1.X', // ← replace with your NAS IP
};
