// ── Configure your SoundTouch devices ─────────────────────────────────────
export default {
  DEVICES: [
    { id: 'device1', name: 'Séjour',  ip: '192.168.1.16' }, // SoundTouch 20
    { id: 'device2', name: 'Cuisine', ip: '192.168.1.17' }, // SoundTouch 10
  ],

  // ── Streams ────────────────────────────────────────────────────────────────
  // Up to 6 entries, each mapped to a SoundTouch preset slot (1–6).
  // Leave `url` empty to disable a slot — it won't appear in the UI dropdown.
  // Stream URLs must be HTTP (not HTTPS) — SoundTouch firmware fetches them directly.
  // `logo` is optional: a public URL or a path served by this app
  // (e.g. /logo.png for public/logo.png).
  STREAMS: [
    { slot: 1, name: 'France Inter', url: 'http://icecast.radiofrance.fr/franceinter-hifi.aac', logo: '/france-inter.svg' },
    { slot: 2, name: 'France Info',  url: 'http://icecast.radiofrance.fr/franceinfo-hifi.aac',  logo: '/Franceinfo.svg' },
    { slot: 3, name: '',             url: '',                                                    logo: null },
    { slot: 4, name: '',             url: '',                                                    logo: null },
    { slot: 5, name: '',             url: '',                                                    logo: null },
    { slot: 6, name: '',             url: '',                                                    logo: null },
  ],

  // ── Web server ──────────────────────────────────────────────────────────────
  HOST: '0.0.0.0',
  PORT: 5010,

  // Set this to your local server fixed LAN IP when running inside Docker.
  // Leave as null to auto-detect (works when running directly on Windows).
  SERVER_IP: '192.168.1.X',
};
