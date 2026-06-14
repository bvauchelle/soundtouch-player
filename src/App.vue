<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';

const streams = ref([]);
const selectedSlot = ref(null);
const devices = ref([]);
const states = ref({});
const message = ref('');
const messageStatus = ref('');
const busy = ref(new Set());

const selectedStream = computed(() =>
  streams.value.find((s) => s.slot === selectedSlot.value) ?? null
);
const stationName = computed(() => selectedStream.value?.name ?? '');
const logoUrl = computed(() => selectedStream.value?.logo ?? null);

function isBusy(deviceId) {
  return busy.value.has(deviceId);
}

const anyPlaying = computed(() =>
  Object.values(states.value).some((s) => s?.playing)
);
const showAll = computed(() => devices.value.length > 1);

let pollHandle = null;

onMounted(async () => {
  try {
    const configFile = await fetch('/api/config');
    const config = await configFile.json();
    streams.value = config.streams ?? [];
    selectedSlot.value = streams.value[0]?.slot ?? null;
    devices.value = config.devices;
  } catch {
    message.value = '✗ Impossible de charger la configuration';
    messageStatus.value = 'fail';
  }
  await pollState();
  pollHandle = setInterval(pollState, 3000);

  // Auto-trigger from URL parameter, e.g. /?play=all or /?play=device1&slot=2.
  // The URL is cleaned up afterwards so a refresh doesn't re-fire the action.
  const params = new URLSearchParams(globalThis.location.search);
  const playParam = params.get('play');
  const slotParam = Number(params.get('slot'));
  if (playParam) {
    if (slotParam && streams.value.some((s) => s.slot === slotParam)) {
      selectedSlot.value = slotParam;
    }
    globalThis.history.replaceState({}, '', globalThis.location.pathname);
    trigger(playParam, 'play');
  }
});

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});

async function pollState() {
  try {
    const res = await fetch('/state');
    states.value = await res.json();
  } catch {}
}

function isPlaying(deviceId) {
  if (deviceId === 'all') return anyPlaying.value;
  return !!states.value[deviceId]?.playing;
}

// Wait (up to `timeoutMs`) until the device(s) report the expected playing
// state. Polls /state aggressively because the user is staring at the spinner.
async function waitForState(deviceId, expectPlaying, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const matches = () => {
    if (deviceId === 'all') {
      return devices.value.every(
        (d) => !!states.value[d.id]?.playing === expectPlaying
      );
    }
    return !!states.value[deviceId]?.playing === expectPlaying;
  };
  while (Date.now() < deadline) {
    if (matches()) return true;
    await new Promise((r) => setTimeout(r, 600));
    await pollState();
  }
  return matches();
}

async function trigger(deviceId, forceVerb = null) {
  if (busy.value.has(deviceId)) return;
  const verb = forceVerb ?? (isPlaying(deviceId) ? 'stop' : 'play');
  if (verb === 'play' && !selectedSlot.value) {
    message.value = '✗ Aucune station configurée';
    messageStatus.value = 'fail';
    return;
  }
  busy.value.add(deviceId);
  message.value = verb === 'stop' ? 'Arrêt…' : 'Envoi…';
  messageStatus.value = '';
  try {
    const url = verb === 'play'
      ? `/play/${encodeURIComponent(deviceId)}/${selectedSlot.value}`
      : `/${verb}/${encodeURIComponent(deviceId)}`;
    const res = await fetch(url);
    const data = await res.json();
    const allOk = Object.values(data.results).every((r) => r.ok);
    if (!allOk) {
      message.value = '✗ ' + JSON.stringify(data.results);
      messageStatus.value = 'fail';
      return;
    }
    // API ack'd. Now wait until the device's reported state actually flips —
    // SoundTouch can take 2–5s to start streaming after the preset key press.
    const reached = await waitForState(deviceId, verb === 'play');
    if (reached) {
      message.value = verb === 'stop' ? '✓ Arrêté' : '✓ Lecture lancée';
      messageStatus.value = 'ok';
    } else {
      message.value = '⚠ Pas de confirmation';
      messageStatus.value = 'fail';
    }
  } catch {
    message.value = '✗ Erreur réseau';
    messageStatus.value = 'fail';
  } finally {
    busy.value.delete(deviceId);
    pollState();
  }
}

const toggle = (deviceId) => trigger(deviceId);

// Serialized throttle for volume: at most one in-flight request per device,
// always sent with the latest dragged value. Avoids flooding the SoundTouch
// HTTP stack while keeping volume responsive during slider drag.
const inFlightVolume = new Map();

async function setVolume(deviceId, value) {
  const level = Number(value);
  // Optimistic local update so the slider thumb and label track the drag
  // even if the next /state poll is seconds away.
  if (states.value[deviceId]) states.value[deviceId].volume = level;

  if (inFlightVolume.has(deviceId)) {
    inFlightVolume.set(deviceId, level);
    return;
  }
  inFlightVolume.set(deviceId, level);
  while (inFlightVolume.has(deviceId)) {
    const target = inFlightVolume.get(deviceId);
    try {
      await fetch(`/volume/${encodeURIComponent(deviceId)}/${target}`);
    } catch {}
    if (inFlightVolume.get(deviceId) === target) inFlightVolume.delete(deviceId);
  }
}
</script>

<template>
  <header class="header">
    <img
      v-if="logoUrl"
      :src="logoUrl"
      :alt="stationName"
      class="logo"
      @error="logoUrl = null"
    />
    <h1>{{ stationName }}</h1>
    <select
      v-if="streams.length > 1"
      class="stream-select"
      :value="selectedSlot"
      @change="selectedSlot = Number($event.target.value)"
    >
      <option v-for="s in streams" :key="s.slot" :value="s.slot">{{ s.name }}</option>
    </select>
  </header>
  <div class="devices">
    <div v-for="d in devices" :key="d.id" class="device">
      <button
        class="btn"
        :class="{ playing: isPlaying(d.id) }"
        :disabled="isBusy(d.id)"
        @click="toggle(d.id)"
      >
        <span v-if="isBusy(d.id)" class="spinner" aria-hidden="true"></span>
        <span v-else class="icon">{{ isPlaying(d.id) ? '⏹' : '▶' }}</span>
        {{ d.name }}
      </button>
      <div class="volume">
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          class="slider"
          :value="states[d.id]?.volume ?? 0"
          @input="setVolume(d.id, $event.target.value)"
        />
        <span class="vol-label">{{ states[d.id]?.volume ?? '–' }}</span>
      </div>
    </div>
    <button
      v-if="showAll"
      class="btn btn-all"
      :class="{ playing: anyPlaying }"
      :disabled="isBusy('all')"
      @click="toggle('all')"
    >
      <span v-if="isBusy('all')" class="spinner" aria-hidden="true"></span>
      <span v-else class="icon">{{ anyPlaying ? '⏹' : '▶' }}</span>
      Les deux
    </button>
  </div>
  <div id="msg" :class="messageStatus">{{ message }}</div>
</template>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, sans-serif;
  background: #1a1a2e;
  color: #eee;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2rem;
}
.header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: .75rem;
}
.logo {
  width: 8rem;
  height: 8rem;
  object-fit: contain;
}
h1 { font-size: 1.6rem; font-weight: 600; letter-spacing: .05em; }
.stream-select {
  background: #2a2a3e;
  color: #eee;
  border: 1px solid #444;
  border-radius: 6px;
  padding: .4rem .6rem;
  font-family: inherit;
  font-size: .95rem;
  cursor: pointer;
}
.stream-select:focus { outline: none; border-color: #e1251b; }
p  { font-size: .85rem; color: #aaa; }
.devices {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: stretch;
  width: min(420px, 90vw);
}
.device {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.device .btn { flex: 0 0 9rem; justify-content: center; padding: .85rem 1rem; }
.volume { flex: 1; display: flex; align-items: center; gap: .6rem; }
.slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: #444;
  border-radius: 2px;
  outline: none;
}
.slider:disabled { opacity: .4; cursor: not-allowed; }
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #e1251b;
  cursor: pointer;
  border: none;
}
.slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #e1251b;
  cursor: pointer;
  border: none;
}
.vol-label {
  font-size: .85rem;
  color: #aaa;
  width: 2.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: .5rem;
  padding: .85rem 2.2rem;
  border: 2px solid transparent;
  border-radius: 999px;
  background: #e1251b;
  color: #fff;
  font-family: inherit;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s, border-color .15s, opacity .15s;
}
.btn:hover:not(:disabled) { opacity: .85; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.playing {
  background: #2a2a3e;
  border-color: #4caf50;
  color: #4caf50;
}
.btn-all { background: #444; align-self: center; }
.btn-all.playing { background: #2a2a3e; }
.icon { font-size: .9em; }
.spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
#msg { font-size: .9rem; min-height: 1.4em; }
.ok   { color: #4caf50; }
.fail { color: #f44336; }
</style>
