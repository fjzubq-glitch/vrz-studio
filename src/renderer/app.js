'use strict';

const api = window.vrl;
const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  accent: '#7c5cff',
  quality: '720',
  fps: 24,
  countdown: 3,
  micId: 'default',
  camId: 'default',
  micMode: 'off',
  camOn: false,
  systemAudio: true,
  mirror: true,
  bubbleSize: 190,
  bubbleCorner: 'br',
  autoLibrary: true,
  lastCrop: null,
  profile: 'class',
  classPrefs: null,
  settingsRev: 5,
};

function isLowPowerDevice() {
  const memory = Number(navigator.deviceMemory) || 8;
  const cores = Number(navigator.hardwareConcurrency) || 8;
  return memory <= 4 || cores <= 2;
}

function isVeryLowPowerDevice() {
  const memory = Number(navigator.deviceMemory) || 8;
  const cores = Number(navigator.hardwareConcurrency) || 8;
  return memory <= 2 || cores <= 2;
}

const CLASS_HINT =
  'Consejo: <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd> inicia o detiene. Mantén <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd> para hablar; al soltar, el micro se apaga.';
const TUTORIAL_HINT =
  'Modo tutorial: se graba <strong>toda la pantalla</strong>, así salen los diálogos de «subir archivo» y cualquier ventana que aparezca. Activá <strong>No molestar</strong> para evitar notificaciones.';

function autoFps() {
  if (isVeryLowPowerDevice()) return 15;
  if (isLowPowerDevice()) return 20;
  return DEFAULTS.fps;
}

const QUALITY_LIMITS = {
  360: [640, 360],
  480: [854, 480],
  720: [1280, 720],
  1080: [1920, 1080],
};

const VIDEO_BITRATES = {
  360: 1200000,
  480: 2000000,
  720: 4500000,
  1080: 8500000,
};

const SELFTEST = new URLSearchParams(location.search).has('selftest');
const CROP_TEST = new URLSearchParams(location.search).has('croptest');
const MIC_TEST = new URLSearchParams(location.search).has('mictest');

const state = {
  source: null,
  sources: [],
  displayStream: null,
  micStream: null,
  camStream: null,
  screenVideo: null,
  camVideo: null,
  audioCtx: null,
  audioDestination: null,
  micSource: null,
  micGain: null,
  micSilentGain: null,
  canvasTrack: null,
  recorder: null,
  chunks: [],
  recordingId: null,
  chunkChain: Promise.resolve(),
  saveError: null,
  saving: false,
  timer: null,
  drawTimer: null,
  recording: false,
  paused: false,
  starting: false,
  micLive: false,
  micStarting: false,
  micPinned: false,
  holdTalk: false,
  micDb: -90,
  analyser: null,
  micTimer: null,
  micLabelState: '',
  cancelling: false,
  elapsed: 0,
  width: 0,
  height: 0,
  nativeWidth: 0,
  nativeHeight: 0,
  recordingTitle: '',
  crop: null,
  cropSnapshot: null,
  cropSourceId: null,
  cropRectPx: null,
  cropDrag: null,
  cropIsAuto: false,
  library: [],
  filter: '',
  renameTarget: null,
  settings: loadSettings(),
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('vrl.settings') || '{}');
    const merged = { ...DEFAULTS, ...raw };
    if (raw.micMode === undefined && raw.micOn !== undefined) {
      merged.micMode = raw.micOn ? 'on' : 'off';
    }
    delete merged.micOn;
    if (raw.settingsRev !== DEFAULTS.settingsRev) {
      merged.settingsRev = DEFAULTS.settingsRev;
      merged.micMode = 'off';
      merged.quality = DEFAULTS.quality;
      merged.fps = autoFps();
      localStorage.setItem('vrl.settings', JSON.stringify(merged));
    }
    // Migración única: pasar de 360p (ajuste de netbook) a 720p en equipos
    // con recursos. No se aplica en equipos de gama muy baja.
    if (
      raw.migration720 !== 1 &&
      Object.keys(raw).length > 0 &&
      !isVeryLowPowerDevice()
    ) {
      merged.quality = '720';
      merged.migration720 = 1;
      localStorage.setItem('vrl.settings', JSON.stringify(merged));
    }
    // El modo Clase/Tutorial no se recuerda: la app siempre abre en Clase para
    // que el selector de fuentes esté disponible desde el primer momento.
    merged.profile = 'class';
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  localStorage.setItem('vrl.settings', JSON.stringify(state.settings));
}

function applyAccent() {
  document.documentElement.style.setProperty('--accent', state.settings.accent);
  document.querySelectorAll('.swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.accent === state.settings.accent);
  });
}

function syncSettingsUI() {
  $('qualitySelect').value = state.settings.quality;
  $('fpsSelect').value = String(state.settings.fps);
  $('countdownSelect').value = String(state.settings.countdown);
  $('countdownDefault').value = String(state.settings.countdown);
  $('mirrorToggle').checked = Boolean(state.settings.mirror);
  $('bubbleSize').value = String(state.settings.bubbleSize);
  $('cornerSelect').value = state.settings.bubbleCorner;
  $('autoLibrary').checked = Boolean(state.settings.autoLibrary);
  $('micModeSelect').value = state.settings.micMode;
  updateMicChip();
  $('chipCam').classList.toggle('on', Boolean(state.settings.camOn));
  $('chipSys').classList.toggle('on', Boolean(state.settings.systemAudio));
  applyAccent();
}

function tutorialCrop(primaryDisplay) {
  return null; // Tutorial captura pantalla completa sin recorte
}

function renderProfile() {
  const tutorial = state.settings.profile === 'tutorial';
  const busy = Boolean(state.recording || state.starting || state.saving);
  document.querySelectorAll('#modeSwitch button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === (tutorial ? 'tutorial' : 'class'));
    btn.disabled = busy;
  });
  $('recordHint').innerHTML = tutorial ? TUTORIAL_HINT : CLASS_HINT;
  $('stageBadge').textContent = tutorial ? 'Tutorial · pantalla completa' : 'Vista previa';
  $('btnPick').disabled = busy;
  $('btnPick').title = '';
  const emptyTitle = document.querySelector('#stageEmpty h2');
  const emptySub = document.querySelector('#stageEmpty p');
  if (emptyTitle) emptyTitle.textContent = tutorial ? 'Modo tutorial' : '¿Qué quieres grabar?';
  if (emptySub) {
    emptySub.textContent = tutorial
      ? 'Se graba el área de trabajo completa, sin la barra de tareas.'
      : 'Elige una pantalla completa o una ventana concreta.';
  }
  $('chipSource').disabled = busy;
  $('chipCrop').disabled = busy || !state.source;
  $('chipSource').title = 'Cambiar fuente';
  $('chipCrop').title = tutorial ? 'En Tutorial se graba la pantalla completa.' : 'Recortar el área a grabar';
}

async function prepareTutorialCrop(source) {
  // Tutorial: captura pantalla completa, sin recorte
  state.crop = null;
  state.cropIsAuto = false;
  state.cropSnapshot = null;
  state.cropSourceId = source ? source.id : null;
  state.cropRectPx = null;
  updateCropLabel();
  return null;
}

async function ensureTutorialSetup() {
  // Si no hay fuente, se elige la pantalla principal. Si el usuario eligió una
  // ventana, se respeta: él decide, y el aviso del selector explica el límite.
  if (!state.source) {
    const sources = await api.listSources();
    const screenSource =
      sources.find((item) => item.type === 'screen' && item.primary) ||
      sources.find((item) => item.type === 'screen');
    if (!screenSource) throw new Error('No hay una pantalla disponible para grabar.');
    await chooseSource(screenSource);
  }
  await prepareTutorialCrop(state.source);
  return state.source;
}

function setProfile(name) {
  if (state.recording || state.starting || state.saving) {
    toast('Detén la grabación para cambiar de modo.', 'error');
    return;
  }
  const next = name === 'tutorial' ? 'tutorial' : 'class';
  if (next === state.settings.profile) return;

  if (next === 'tutorial') {
    state.settings.classPrefs = {
      quality: state.settings.quality,
      fps: state.settings.fps,
      countdown: state.settings.countdown,
    };
    state.settings.profile = 'tutorial';
    state.settings.quality = '720';
    state.settings.fps = 30;
    state.settings.countdown = 0;
  } else {
    const prefs = state.settings.classPrefs || {};
    state.settings.profile = 'class';
    state.settings.quality = prefs.quality || '720';
    state.settings.fps = prefs.fps || autoFps();
    state.settings.countdown =
      typeof prefs.countdown === 'number' ? prefs.countdown : 3;
    if (state.cropIsAuto) {
      state.crop = null;
      state.cropIsAuto = false;
      state.cropSnapshot = null;
      state.cropRectPx = null;
      updateCropThumb();
    }
    updateCropLabel();
  }

  syncSettingsUI();
  saveSettings();
  renderProfile();

  if (next === 'tutorial') {
    toast('Modo Tutorial: pantalla completa, 720p y 30 fps.', 'ok');
    ensureTutorialSetup().catch((err) => {
      console.error(err);
      toast('No se pudo preparar el modo Tutorial.', 'error');
    });
  } else {
    toast('Modo Clase.');
  }
}

function updateMicChip() {
  let live;
  let label;

  if (state.recording) {
    live = state.micLive;
    if (state.micStarting) label = 'Abriendo micro…';
    else if (state.micLive) label = 'Micrófono activo';
    else label = 'Activar micrófono';
  } else {
    live = state.settings.micMode === 'on';
    label = live ? 'Micrófono' : 'Sin micrófono';
  }

  const key = `${label}|${live}`;
  if (key === state.micLabelState) return;
  state.micLabelState = key;
  $('chipMic').classList.toggle('on', live);
  $('chipMic').classList.remove('muted');
  $('micLabel').textContent = label;
  $('chipMic').title = state.recording
    ? 'Clic para activar o desactivar el micrófono. Mantén Ctrl+Shift+M para hablar.'
    : 'Activa el micrófono solo cuando vayas a hablar.';
  syncFloatingState();
}

function toggleMicMode() {
  state.settings.micMode = state.settings.micMode === 'on' ? 'off' : 'on';
  $('micModeSelect').value = state.settings.micMode;
  saveSettings();
  updateMicChip();
  if (state.settings.micMode === 'on') refreshDevices();
  toast(
    state.settings.micMode === 'on'
      ? 'El micrófono se encenderá al iniciar la grabación.'
      : 'Micrófono apagado: solo se grabará el audio de la clase.',
  );
}

function micConstraints() {
  return state.settings.micId === 'default'
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : { deviceId: { exact: state.settings.micId }, echoCancellation: true };
}

function connectMicToGraph() {
  if (!state.micStream || !state.audioCtx || !state.audioDestination) return;
  const source = state.audioCtx.createMediaStreamSource(state.micStream);
  const gain = state.audioCtx.createGain();
  gain.gain.value = 1;
  source.connect(gain).connect(state.audioDestination);

  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.35;
  source.connect(analyser);

  const silent = state.audioCtx.createGain();
  silent.gain.value = 0;
  analyser.connect(silent).connect(state.audioCtx.destination);

  state.micSource = source;
  state.micGain = gain;
  state.micSilentGain = silent;
  state.analyser = analyser;
}

async function attachMicStream() {
  if (!state.audioCtx || !state.audioDestination) {
    throw new Error('El audio de la grabación todavía no está listo.');
  }
  if (state.micStream) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micConstraints(),
    video: false,
  });
  state.micStream = stream;
  connectMicToGraph();
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
}

function detachMic() {
  stopMicMeter();
  try {
    if (state.micSource) state.micSource.disconnect();
    if (state.micGain) state.micGain.disconnect();
    if (state.analyser) state.analyser.disconnect();
    if (state.micSilentGain) state.micSilentGain.disconnect();
  } catch {
    /* nodos ya desconectados */
  }
  if (state.micStream) state.micStream.getTracks().forEach((track) => track.stop());
  state.micStream = null;
  state.micSource = null;
  state.micGain = null;
  state.micSilentGain = null;
  state.analyser = null;
  updateMicMeter(-90);
}

async function enableRecordingMic({ pinned = false, silent = false } = {}) {
  if (!state.recording || state.micLive || state.micStarting) return false;
  state.micStarting = true;
  state.micPinned = pinned;
  updateMicChip();

  try {
    await attachMicStream();
    state.micLive = true;
    startMicMeter();
    if (!silent) toast('Micrófono activado. Habla ahora.', 'ok');
    return true;
  } catch (err) {
    state.micPinned = false;
    toast(`No se pudo activar el micrófono: ${friendlyError(err)}`, 'error');
    return false;
  } finally {
    state.micStarting = false;
    updateMicChip();
  }
}

function disableRecordingMic({ silent = false } = {}) {
  detachMic();
  state.micLive = false;
  state.micPinned = false;
  state.holdTalk = false;
  if (!silent) toast('Micrófono desactivado: solo se graba el audio de la clase.');
  updateMicChip();
}

async function toggleRecordingMic() {
  if (state.micStarting) return;
  if (state.micLive) disableRecordingMic();
  else await enableRecordingMic({ pinned: true });
}

async function beginHoldTalk() {
  if (!state.recording || state.micLive || state.holdTalk || state.micStarting) return;
  state.holdTalk = true;
  const ok = await enableRecordingMic({ pinned: false, silent: true });
  if (!ok) state.holdTalk = false;
}

function endHoldTalk() {
  if (!state.holdTalk) return;
  state.holdTalk = false;
  if (!state.micPinned) disableRecordingMic({ silent: true });
}

function updateMicMeter(db) {
  const meter = $('micMeter');
  if (!meter) return;
  const level = Math.max(0, Math.min(5, Math.round((db + 60) / 10)));
  Array.from(meter.children).forEach((bar, index) => {
    bar.classList.toggle('lit', index < level);
  });
}

function startMicMeter() {
  stopMicMeter();
  const analyser = state.analyser;
  if (!analyser) return;
  const data = new Float32Array(analyser.fftSize);
  state.micTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const db = 20 * Math.log10(rms + 1e-8);
    state.micDb = db;
    updateMicMeter(db);
  }, 60);
}

function stopMicMeter() {
  if (state.micTimer) clearInterval(state.micTimer);
  state.micTimer = null;
  updateMicMeter(-90);
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 320);
  }, 3800);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('es', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function defaultTitle() {
  const when = new Date()
    .toLocaleString('es', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(/:/g, '-');
  return `${state.settings.profile === 'tutorial' ? 'Tutorial' : 'Grabación'} ${when}`;
}

/* ---------------- navigation ---------------- */

function setView(name) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${name}`);
  });
  if (name === 'library') loadLibrary();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.recording && btn.dataset.view !== 'record') {
      toast('Detén la grabación para cambiar de sección.', 'error');
      return;
    }
    setView(btn.dataset.view);
  });
});

document.querySelectorAll('[data-go]').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.go));
});

document.querySelectorAll('[data-win]').forEach((btn) => {
  btn.addEventListener('click', () => api.winControl(btn.dataset.win));
});

document.querySelectorAll('#modeSwitch button').forEach((btn) => {
  btn.addEventListener('click', () => setProfile(btn.dataset.mode));
});

/* ---------------- settings ---------------- */

function bindSettings() {
  $('swatches').addEventListener('click', (event) => {
    const swatch = event.target.closest('.swatch');
    if (!swatch) return;
    state.settings.accent = swatch.dataset.accent;
    saveSettings();
    applyAccent();
  });

  $('qualitySelect').addEventListener('change', (e) => {
    state.settings.quality = e.target.value;
    saveSettings();
  });
  $('fpsSelect').addEventListener('change', (e) => {
    state.settings.fps = Number(e.target.value);
    saveSettings();
  });
  $('countdownDefault').addEventListener('change', (e) => {
    state.settings.countdown = Number(e.target.value);
    $('countdownSelect').value = e.target.value;
    saveSettings();
  });
  $('countdownSelect').addEventListener('change', (e) => {
    state.settings.countdown = Number(e.target.value);
    $('countdownDefault').value = e.target.value;
    saveSettings();
  });
  $('mirrorToggle').addEventListener('change', (e) => {
    state.settings.mirror = e.target.checked;
    saveSettings();
  });
  $('bubbleSize').addEventListener('input', (e) => {
    state.settings.bubbleSize = Number(e.target.value);
    saveSettings();
  });
  $('cornerSelect').addEventListener('change', (e) => {
    state.settings.bubbleCorner = e.target.value;
    saveSettings();
  });
  $('autoLibrary').addEventListener('change', (e) => {
    state.settings.autoLibrary = e.target.checked;
    saveSettings();
  });
  $('micModeSelect').addEventListener('change', (e) => {
    state.settings.micMode = e.target.value === 'on' ? 'on' : 'off';
    saveSettings();
    updateMicChip();
  });

  ['btnOpenFolder', 'btnFolder'].forEach((id) => {
    $(id).addEventListener('click', () => api.openFolder());
  });

  $('chipMic').addEventListener('click', () => {
    if (state.recording) toggleRecordingMic();
    else toggleMicMode();
  });

  $('chipCam').addEventListener('click', () => {
    state.settings.camOn = !state.settings.camOn;
    $('chipCam').classList.toggle('on', state.settings.camOn);
    saveSettings();
    if (state.settings.camOn) refreshDevices();
  });

  $('chipSys').addEventListener('click', async () => {
    state.settings.systemAudio = !state.settings.systemAudio;
    $('chipSys').classList.toggle('on', state.settings.systemAudio);
    saveSettings();
    if (state.source) await api.selectSource(state.source.id, state.settings.systemAudio);
  });

  $('chipSource').addEventListener('click', openSourceModal);
  $('chipCrop').addEventListener('click', openCropModal);
  $('btnPick').addEventListener('click', openSourceModal);
  $('btnRefreshSources').addEventListener('click', refreshSources);

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => setCropRectFromState(btn.dataset.preset));
  });
  $('btnCropApply').addEventListener('click', applyCrop);
  $('btnCropClear').addEventListener('click', clearCrop);
  $('cropBox').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const handle = event.target.closest('.crop-handle');
    startCropDrag(event, handle ? handle.dataset.dir : 'move');
  });

  $('micSelect').addEventListener('change', (e) => {
    state.settings.micId = e.target.value;
    saveSettings();
  });
  $('camSelect').addEventListener('change', (e) => {
    state.settings.camId = e.target.value;
    saveSettings();
  });

  $('btnRecord').addEventListener('click', () => {
    if (state.recording) stopRecording();
    else startRecording();
  });
  $('btnStop').addEventListener('click', stopRecording);
  $('btnPause').addEventListener('click', togglePause);

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderLibrary();
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });

  $('btnRenameSave').addEventListener('click', saveRename);
  $('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRename();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('cropModal').classList.contains('hidden')) {
      closeModal('cropModal');
      return;
    }
    if (!$('countdown').classList.contains('hidden')) state.cancelling = true;
  });

  api.onToggleRecord(() => {
    if (state.recording) stopRecording();
    else if (!state.starting) startRecording();
  });
  api.onMicHoldStart(beginHoldTalk);
  api.onMicHoldEnd(endHoldTalk);
  api.onFloatingAction((action) => {
    if (action === 'stop') stopRecording();
    else if (action === 'pause') togglePause();
    else if (action === 'mic') toggleRecordingMic();
  });
}

function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  if (id === 'cropModal') endCropDrag();
  modal.classList.add('hidden');
  if (id === 'playerModal') {
    const video = $('player');
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

/* ---------------- devices ---------------- */

function fillSelect(select, devices, selected, fallbackLabel) {
  const previous = selected || select.value;
  select.innerHTML = '';
  const fallback = document.createElement('option');
  fallback.value = 'default';
  fallback.textContent = fallbackLabel;
  select.appendChild(fallback);
  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Dispositivo ${index + 1}`;
    select.appendChild(option);
  });
  select.value = [...select.options].some((o) => o.value === previous) ? previous : 'default';
}

async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillSelect(
      $('micSelect'),
      devices.filter((d) => d.kind === 'audioinput'),
      state.settings.micId,
      'Micrófono predeterminado',
    );
    fillSelect(
      $('camSelect'),
      devices.filter((d) => d.kind === 'videoinput'),
      state.settings.camId,
      'Cámara predeterminada',
    );
    state.settings.micId = $('micSelect').value;
    state.settings.camId = $('camSelect').value;
  } catch {
    /* sin permisos todavía */
  }
}

async function primeDevices() {
  if (state.recording || state.micStream) {
    await refreshDevices();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    /* el usuario puede conceder permiso más tarde */
  }
  await refreshDevices();
}

// No abrimos el micrófono durante el arranque: en equipos modestos satura el
// controlador de audio justo cuando la ventana empieza a dibujarse. Se hace
// después, cuando la interfaz ya está estable y el equipo está libre.
function schedulePrimeDevices() {
  setTimeout(() => {
    if (state.recording) return;
    const idle = window.requestIdleCallback;
    if (typeof idle === 'function') idle(() => primeDevices(), { timeout: 8000 });
    else primeDevices();
  }, 4000);
}

/* ---------------- sources ---------------- */

function openSourceModal() {
  $('sourceModal').classList.remove('hidden');
  refreshSources();
}

async function refreshSources() {
  $('screenGrid').innerHTML = '<div class="source-empty">Buscando pantallas…</div>';
  $('windowGrid').innerHTML = '';
  $('sourceEmpty').classList.add('hidden');
  try {
    state.sources = await api.listSources();
  } catch (err) {
    state.sources = [];
    toast('No se pudieron listar las fuentes.', 'error');
  }

  const screens = state.sources.filter((s) => s.type === 'screen');
  const windows = state.sources.filter((s) => s.type === 'window');
  $('screenGrid').innerHTML = '';
  $('windowGrid').innerHTML = '';

  screens.forEach((source) => $('screenGrid').appendChild(sourceItem(source)));
  windows.forEach((source) => $('windowGrid').appendChild(sourceItem(source)));

  if (!screens.length) {
    $('screenGrid').innerHTML = '<div class="source-empty">Sin pantallas disponibles.</div>';
  }
  if (!windows.length) {
    $('windowGrid').innerHTML = '<div class="source-empty">Sin ventanas abiertas para compartir.</div>';
  } else if (state.settings.profile === 'tutorial') {
    const note = document.createElement('p');
    note.className = 'source-note';
    note.textContent =
      'Si elegís una ventana, los diálogos de «subir archivo» no salen: Windows los abre fuera de ella. Para que salgan, elegí «Toda la pantalla».';
    $('windowGrid').prepend(note);
  }
  if (!state.sources.length) $('sourceEmpty').classList.remove('hidden');
}

function sourceItem(source) {
  const button = document.createElement('button');
  button.className = 'source-item';
  button.type = 'button';

  if (source.thumbnail) {
    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = '';
    button.appendChild(img);
  }

  const name = document.createElement('div');
  name.className = 'source-name';
  if (source.appIcon) {
    const icon = document.createElement('img');
    icon.src = source.appIcon;
    icon.alt = '';
    name.appendChild(icon);
  }
  const label = document.createElement('span');
  label.textContent = source.name;
  name.appendChild(label);
  button.appendChild(name);

  button.addEventListener('click', () => chooseSource(source));
  return button;
}

async function chooseSource(source) {
  state.source = source;
  await api.selectSource(source.id, state.settings.systemAudio);
  closeModal('sourceModal');

  state.crop = null;
  state.cropSnapshot = null;
  state.cropSourceId = source.id;
  state.cropRectPx = null;
  state.cropIsAuto = false;
  updateCropLabel();
  if (state.settings.profile === 'tutorial') await prepareTutorialCrop(source);
  renderProfile();

  const stage = $('stage');
  stage.classList.add('has-source');
  stage.classList.remove('ready', 'recording');

  const thumb = $('stageThumb');
  if (source.thumbnail) {
    thumb.style.display = '';
    thumb.src = source.thumbnail;
    thumb.onload = () => stage.classList.add('ready');
  } else {
    thumb.removeAttribute('src');
    thumb.style.display = 'none';
    stage.classList.add('ready');
  }

  $('sourceName').textContent = source.name;
  $('stageBadge').classList.remove('hidden');
  $('btnRecord').disabled = false;
}

async function openCropModal() {
  if (!state.source || state.recording || state.starting) return;
  const chip = $('chipCrop');
  chip.disabled = true;
  $('cropLabel').textContent = 'Capturando…';

  try {
    if (!state.cropSnapshot || state.cropSourceId !== state.source.id) {
      const wantAudio = state.settings.systemAudio;
      state.settings.systemAudio = false;
      let stream = null;
      try {
        await api.selectSource(state.source.id, false);
        stream = await getDisplayStream();
        const video = await makeVideo(stream);
        await Promise.race([
          new Promise((resolve) => {
            if (typeof video.requestVideoFrameCallback === 'function') {
              video.requestVideoFrameCallback(() => resolve());
            } else {
              setTimeout(resolve, 300);
            }
          }),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        state.cropSnapshot = canvas;
      } finally {
        if (stream) stream.getTracks().forEach((track) => track.stop());
        state.settings.systemAudio = wantAudio;
        await api.selectSource(state.source.id, wantAudio);
      }
    }

    const img = $('cropImage');
    await new Promise((resolve) => {
      img.onload = resolve;
      img.onerror = resolve;
      img.src = state.cropSnapshot.toDataURL('image/jpeg', 0.9);
    });

    $('cropModal').classList.remove('hidden');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    setCropRectFromState(state.crop ? null : 'full');
  } catch (err) {
    toast('No se pudo capturar la vista previa. Inténtalo de nuevo.', 'error');
    console.error(err);
  } finally {
    renderProfile();
    updateCropLabel();
  }
}

function updateCropLabel() {
  if (state.settings.profile === 'tutorial' && !state.crop) {
    $('cropLabel').textContent = 'Pantalla completa';
    return;
  }
  if (!state.crop) {
    $('cropLabel').textContent = 'Recortar';
    return;
  }
  const snap = state.cropSnapshot;
  $('cropLabel').textContent = snap
    ? `${Math.round(snap.width * state.crop.w)} × ${Math.round(snap.height * state.crop.h)}`
    : 'Área recortada';
}

function ratiosToPx(crop, width, height) {
  return { x: crop.x * width, y: crop.y * height, w: crop.w * width, h: crop.h * height };
}

function clampRect(rect, width, height) {
  const min = 32;
  let { x, y, w, h } = rect;
  w = Math.min(Math.max(w, min), width);
  h = Math.min(Math.max(h, min), height);
  x = Math.min(Math.max(0, x), width - w);
  y = Math.min(Math.max(0, y), height - h);
  return { x, y, w, h };
}

function fit16x9(width, height, mode) {
  let w;
  let h;
  if (width / height > 16 / 9) {
    h = height;
    w = height * (16 / 9);
  } else {
    w = width;
    h = width * (9 / 16);
  }
  return { x: (width - w) / 2, y: mode === 'bottom' ? height - h : (height - h) / 2, w, h };
}

function setCropRectFromState(preset) {
  const img = $('cropImage');
  const width = img.clientWidth;
  const height = img.clientHeight;
  if (!width || !height) return;

  let rect;
  if (preset === 'center' || preset === 'bottom') rect = fit16x9(width, height, preset);
  else if (preset === 'last' && state.settings.lastCrop) rect = ratiosToPx(state.settings.lastCrop, width, height);
  else if (state.crop && !preset) rect = ratiosToPx(state.crop, width, height);
  else rect = { x: 0, y: 0, w: width, h: height };

  state.cropRectPx = clampRect(rect, width, height);
  paintCropBox();
}

function paintCropBox() {
  const rect = state.cropRectPx;
  if (!rect) return;
  const box = $('cropBox');
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.w}px`;
  box.style.height = `${rect.h}px`;

  const img = $('cropImage');
  const snapW = state.cropSnapshot?.width || img.naturalWidth || img.clientWidth;
  const snapH = state.cropSnapshot?.height || img.naturalHeight || img.clientHeight;
  const pxW = Math.round((rect.w / img.clientWidth) * snapW);
  const pxH = Math.round((rect.h / img.clientHeight) * snapH);
  $('cropSize').textContent = `${pxW} × ${pxH} px`;
}

function startCropDrag(event, mode) {
  const img = $('cropImage');
  if (!state.cropRectPx || !img.clientWidth) return;
  event.preventDefault();
  state.cropDrag = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    rect: { ...state.cropRectPx },
    width: img.clientWidth,
    height: img.clientHeight,
  };
  window.addEventListener('pointermove', onCropDrag);
  window.addEventListener('pointerup', endCropDrag, { once: true });
}

function onCropDrag(event) {
  const drag = state.cropDrag;
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  let { x, y, w, h } = drag.rect;

  if (drag.mode === 'move') {
    x += dx;
    y += dy;
  } else {
    if (drag.mode.includes('w')) {
      x += dx;
      w -= dx;
    }
    if (drag.mode.includes('n')) {
      y += dy;
      h -= dy;
    }
    if (drag.mode.includes('e')) w += dx;
    if (drag.mode.includes('s')) h += dy;
  }

  const min = 32;
  if (w < min) {
    if (drag.mode.includes('w')) x -= min - w;
    w = min;
  }
  if (h < min) {
    if (drag.mode.includes('n')) y -= min - h;
    h = min;
  }

  x = Math.max(0, Math.min(x, drag.width - w));
  y = Math.max(0, Math.min(y, drag.height - h));
  w = Math.min(w, drag.width - x);
  h = Math.min(h, drag.height - y);

  state.cropRectPx = { x, y, w, h };
  paintCropBox();
}

function endCropDrag() {
  state.cropDrag = null;
  window.removeEventListener('pointermove', onCropDrag);
}

function applyCrop() {
  const img = $('cropImage');
  const rect = state.cropRectPx;
  const width = img.clientWidth;
  const height = img.clientHeight;
  if (!rect || !width || !height) {
    closeModal('cropModal');
    return;
  }

  const pxW = Math.round((rect.w / width) * (state.cropSnapshot?.width || width));
  const pxH = Math.round((rect.h / height) * (state.cropSnapshot?.height || height));
  const nearFull = rect.x <= 2 && rect.y <= 2 && rect.w >= width - 2 && rect.h >= height - 2;

  if (nearFull) {
    state.crop = null;
    state.settings.lastCrop = null;
  } else {
    state.crop = { x: rect.x / width, y: rect.y / height, w: rect.w / width, h: rect.h / height };
    state.settings.lastCrop = { ...state.crop };
  }
  state.cropIsAuto = false;

  saveSettings();
  closeModal('cropModal');
  updateCropLabel();
  updateCropThumb();
  toast(
    state.crop ? `Área recortada: ${pxW} × ${pxH} px.` : 'Se grabará la pantalla completa.',
    'ok',
  );
}

function clearCrop() {
  state.crop = null;
  state.cropIsAuto = false;
  state.settings.lastCrop = null;
  saveSettings();
  closeModal('cropModal');
  updateCropLabel();
  updateCropThumb();
  toast('Recorte eliminado. Se grabará la pantalla completa.');
}

function updateCropThumb() {
  if (!state.source) return;
  const thumb = $('stageThumb');
  const stage = $('stage');

  if (state.crop && state.cropSnapshot) {
    const src = state.cropSnapshot;
    const crop = state.crop;
    const out = document.createElement('canvas');
    out.width = Math.max(2, Math.round(src.width * crop.w));
    out.height = Math.max(2, Math.round(src.height * crop.h));
    out
      .getContext('2d')
      .drawImage(
        src,
        crop.x * src.width,
        crop.y * src.height,
        crop.w * src.width,
        crop.h * src.height,
        0,
        0,
        out.width,
        out.height,
      );
    thumb.onload = () => stage.classList.add('ready');
    thumb.style.display = '';
    thumb.src = out.toDataURL('image/jpeg', 0.82);
  } else if (state.source.thumbnail) {
    thumb.style.display = '';
    thumb.src = state.source.thumbnail;
  }
}

/* ---------------- recording ---------------- */

async function getDisplayStream() {
  const video = { frameRate: state.settings.fps };
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio: state.settings.systemAudio });
  } catch (err) {
    if (state.settings.systemAudio) {
      try {
        toast('Audio del sistema no disponible; se graba sin él.', 'error');
        await api.selectSource(state.source.id, false);
        return await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      } catch {
        /* sigue con el fallback */
      }
    }
    if (state.source?.id) {
      return navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: state.source.id,
            maxFrameRate: state.settings.fps,
          },
        },
        audio: false,
      });
    }
    throw err;
  }
}

async function makeVideo(stream) {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      const done = () => resolve();
      video.onloadedmetadata = done;
      setTimeout(done, 1500);
    });
  }
  return video;
}

function setupCanvas() {
  const track = state.displayStream.getVideoTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const nativeWidth = settings.width || state.screenVideo.videoWidth || 1920;
  const nativeHeight = settings.height || state.screenVideo.videoHeight || 1080;
  const crop = state.crop;

  const sourceWidth = crop ? Math.max(2, nativeWidth * crop.w) : nativeWidth;
  const sourceHeight = crop ? Math.max(2, nativeHeight * crop.h) : nativeHeight;

  let width = Math.round(sourceWidth / 2) * 2;
  let height = Math.round(sourceHeight / 2) * 2;
  if (state.settings.quality !== 'source') {
    const [maxWidth, maxHeight] = QUALITY_LIMITS[state.settings.quality] || QUALITY_LIMITS[1080];
    const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
    width = Math.round((sourceWidth * scale) / 2) * 2;
    height = Math.round((sourceHeight * scale) / 2) * 2;
  }

  state.width = Math.max(2, width);
  state.height = Math.max(2, height);
  state.nativeWidth = nativeWidth;
  state.nativeHeight = nativeHeight;

  const canvas = $('canvas');
  canvas.width = state.width;
  canvas.height = state.height;

  const stage = $('stage');
  stage.classList.add('recording');
  stage.classList.remove('has-source');
  $('stageBadge').classList.add('hidden');
  $('stageEmpty').classList.add('hidden');

  drawFrame();
}

function drawBubble(ctx) {
  const video = state.camVideo;
  if (!video || video.readyState < 2) return;

  const { width, height } = state;
  const scale = width / 1920;
  const size = state.settings.bubbleSize * Math.max(scale, 0.55);
  const margin = Math.max(16, 28 * scale);
  const radius = size / 2;

  let cx;
  let cy;
  switch (state.settings.bubbleCorner) {
    case 'bl':
      cx = margin + radius;
      cy = height - margin - radius;
      break;
    case 'tr':
      cx = width - margin - radius;
      cy = margin + radius;
      break;
    case 'tl':
      cx = margin + radius;
      cy = margin + radius;
      break;
    default:
      cx = width - margin - radius;
      cy = height - margin - radius;
  }

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 26 * scale;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#0b0d12';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  if (state.settings.mirror) {
    ctx.translate(cx * 2, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, sx, sy, side, side, cx - radius, cy - radius, size, size);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, radius - 1.5), 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.88)';
  ctx.lineWidth = Math.max(2, 5 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawFrame() {
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, state.width, state.height);
  if (state.screenVideo && state.screenVideo.readyState >= 2) {
    const crop = state.crop;
    if (crop) {
      const vw = state.screenVideo.videoWidth || state.width;
      const vh = state.screenVideo.videoHeight || state.height;
      ctx.drawImage(
        state.screenVideo,
        crop.x * vw,
        crop.y * vh,
        crop.w * vw,
        crop.h * vh,
        0,
        0,
        state.width,
        state.height,
      );
    } else {
      ctx.drawImage(state.screenVideo, 0, 0, state.width, state.height);
    }
  }
  drawBubble(ctx);
  if (state.canvasTrack && typeof state.canvasTrack.requestFrame === 'function') {
    state.canvasTrack.requestFrame();
  }
}

function startDrawing() {
  stopDrawing();
  const interval = Math.max(15, Math.round(1000 / state.settings.fps));
  state.drawTimer = setInterval(drawFrame, interval);
}

function stopDrawing() {
  if (state.drawTimer) clearInterval(state.drawTimer);
  state.drawTimer = null;
}

function runCountdown(seconds) {
  return new Promise((resolve) => {
    if (!seconds) {
      resolve(true);
      return;
    }
    const overlay = $('countdown');
    const number = $('countdownNumber');
    overlay.classList.remove('hidden');
    state.cancelling = false;
    let remaining = seconds;

    const tick = () => {
      if (state.cancelling) {
        overlay.classList.add('hidden');
        resolve(false);
        return;
      }
      if (remaining <= 0) {
        overlay.classList.add('hidden');
        resolve(true);
        return;
      }
      number.textContent = String(remaining);
      number.classList.remove('pop');
      void number.offsetWidth;
      number.classList.add('pop');
      remaining -= 1;
      setTimeout(tick, 880);
    };
    tick();
  });
}

function showStageLoading(show) {
  $('stageLoading').classList.toggle('hidden', !show);
}

async function startRecording() {
  if (state.recording || state.starting) return;
  if (state.saving) {
    toast('Espera a que termine de guardarse la grabación anterior.');
    return;
  }
  if (state.settings.profile === 'tutorial') {
    state.starting = true;
    try {
      await ensureTutorialSetup();
    } catch (err) {
      state.starting = false;
      renderProfile();
      toast(`No se pudo preparar el tutorial: ${friendlyError(err)}`, 'error');
      console.error(err);
      return;
    }
    state.starting = false;
    renderProfile();
  }
  if (!state.source) {
    openSourceModal();
    return;
  }
  if (state.settings.micMode === 'off' && !state.settings.systemAudio) {
    toast('Activa «Audio sistema» o el micrófono: si no, el vídeo saldrá sin sonido.', 'error');
    return;
  }

  state.starting = true;
  $('btnRecord').disabled = true;
  showStageLoading(true);

  // Ocultamos la app antes de capturar para que no aparezca en el inicio del video.
  // Se vuelve a mostrar al terminar.
  let hiddenApp = false;
  try {
    await api.winControl('hide');
    hiddenApp = true;
    await new Promise((r) => setTimeout(r, 250));
  } catch (err) {
    console.warn('No se pudo ocultar la app antes de grabar:', err);
  }

  try {
    await api.selectSource(state.source.id, state.settings.systemAudio);

    state.displayStream = await getDisplayStream();

    if (state.settings.micMode !== 'off') {
      try {
        state.micStream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(),
          video: false,
        });
      } catch {
        toast('No se pudo abrir el micrófono. Puedes activarlo durante la grabación.', 'error');
      }
    }

    if (state.settings.camOn) {
      try {
        state.camStream = await navigator.mediaDevices.getUserMedia({
          video:
            state.settings.camId === 'default'
              ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } }
              : {
                  deviceId: { exact: state.settings.camId },
                  width: { ideal: 320 },
                  height: { ideal: 240 },
                  frameRate: { ideal: 15, max: 24 },
                },
          audio: false,
        });
      } catch {
        toast('No se pudo abrir la cámara. Se grabará sin burbuja.', 'error');
      }
    }

    state.screenVideo = await makeVideo(state.displayStream);
    if (state.camStream) state.camVideo = await makeVideo(state.camStream);

    state.micLive = Boolean(state.micStream);
    state.micPinned = state.micLive;
    state.micStarting = false;
    state.holdTalk = false;
    updateMicChip();

    setupCanvas();
    startDrawing();
    showStageLoading(false);

    const proceed = await runCountdown(state.settings.countdown);
    if (!proceed) {
      cleanupCapture();
      toast('Grabación cancelada.');
      return;
    }

    await beginRecorder();
    if (!state.recording) $('btnRecord').disabled = false;
  } catch (err) {
    cleanupCapture();
    showStageLoading(false);
    toast(`No se pudo iniciar: ${friendlyError(err)}`, 'error');
    console.error(err);
  } finally {
    state.starting = false;
    if (!state.recording) showAppWindow();
    if (!state.recording) $('btnRecord').disabled = false;
    renderProfile();
  }
}

function friendlyError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') return 'permiso denegado por el sistema.';
  if (name === 'NotFoundError') return 'no se encontró el dispositivo.';
  if (name === 'NotReadableError') return 'el dispositivo está en uso por otra aplicación.';
  return err?.message || String(err);
}

function pickMimeType(preferLowPower = false) {
  const options = preferLowPower
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function buildAudioTrack() {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  state.audioCtx = context;
  state.audioDestination = destination;

  const systemTracks = state.displayStream.getAudioTracks();
  if (systemTracks.length) {
    const source = context.createMediaStreamSource(new MediaStream(systemTracks));
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
  }

  if (state.micStream) connectMicToGraph();

  return destination.stream.getAudioTracks()[0] || null;
}

async function beginRecorder() {
  const canvas = $('canvas');
  const stream = canvas.captureStream(0);
  state.canvasTrack = stream.getVideoTracks()[0] || null;
  const audioTrack = buildAudioTrack();
  if (audioTrack) stream.addTrack(audioTrack);

  const bitrate = VIDEO_BITRATES[state.settings.quality] || 12000000;
  const lowPower = isLowPowerDevice();

  try {
    state.recorder = new MediaRecorder(stream, {
      mimeType: pickMimeType(lowPower),
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 160000,
    });
  } catch (err) {
    cleanupCapture();
    toast('El codificador de vídeo no está disponible.', 'error');
    console.error(err);
    return;
  }

  state.chunks = [];
  state.recordingId = null;
  state.chunkChain = Promise.resolve();
  state.saveError = null;
  try {
    state.recordingId = await api.recordingBegin();
  } catch (err) {
    toast('No se pudo crear el archivo; se guardará en memoria.', 'error');
    console.error(err);
  }

  state.recorder.ondataavailable = (event) => {
    const blob = event.data;
    if (!blob || !blob.size) return;
    const sessionId = state.recordingId;
    if (!sessionId) {
      state.chunks.push(blob);
      return;
    }
    state.chunkChain = state.chunkChain
      .then(async () => {
        const buffer = await blob.arrayBuffer();
        await api.recordingChunk(sessionId, new Uint8Array(buffer));
      })
      .catch((err) => {
        if (!state.saveError) state.saveError = err;
        console.error(err);
      });
  };
  state.recorder.onstop = finalizeRecording;
  state.recorder.onerror = (event) => {
    toast(`Error de grabación: ${event.error?.message || 'desconocido'}`, 'error');
  };
  state.recorder.start(1000);
  api.watchMicHold(true).catch(() => {});
  if (state.micLive) startMicMeter();

  state.recording = true;
  state.paused = false;
  state.elapsed = 0;
  state.recordingTitle = defaultTitle();
  startTimer();
  setRecordingUI(true);
  toast('Grabando. Ctrl+Shift+R para detener; mantén Ctrl+Shift+M para hablar.', 'ok');
}

function startTimer() {
  stopTimer();
  updateTimer();
  state.timer = setInterval(() => {
    if (!state.paused) {
      state.elapsed += 0.25;
      updateTimer();
    }
  }, 250);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function updateTimer() {
  $('recTime').textContent = formatClock(state.elapsed);
  syncFloatingState();
}

let lastFloatingKey = '';

function syncFloatingState() {
  const payload = {
    recording: state.recording,
    saving: state.saving,
    paused: state.paused,
    micLive: state.micLive,
    micStarting: state.micStarting,
    elapsed: Math.floor(state.elapsed),
    accent: state.settings.accent,
  };
  const key = JSON.stringify(payload);
  if (key === lastFloatingKey) return;
  lastFloatingKey = key;
  api.recordingState(payload).catch(() => {});
}

function togglePause() {
  if (!state.recorder) return;
  if (state.recorder.state === 'recording') {
    state.recorder.pause();
    state.paused = true;
    $('btnPause').textContent = 'Reanudar';
    $('recPaused').classList.remove('hidden');
  } else if (state.recorder.state === 'paused') {
    state.recorder.resume();
    state.paused = false;
    $('btnPause').textContent = 'Pausar';
    $('recPaused').classList.add('hidden');
  }
  syncFloatingState();
}

function stopRecording() {
  if (!state.recorder || state.recorder.state === 'inactive') return;
  $('btnStop').disabled = true;
  $('btnPause').disabled = true;
  try {
    state.recorder.stop();
  } catch (err) {
    console.error(err);
  }
}

function showAppWindow() {
  api.winControl('show').catch(() => {});
}

async function finalizeRecording() {
  stopTimer();
  stopDrawing();
  state.recording = false;
  state.saving = true;
  setRecordingUI(false);
  $('btnRecord').disabled = true;
  syncFloatingState();

  try {
    let info;
    const meta = {
      title: state.recordingTitle,
      duration: Math.max(1, Math.round(state.elapsed)),
      width: state.width,
      height: state.height,
    };

    if (state.recordingId) {
      toast('Guardando grabación…');
      let chain;
      do {
        chain = state.chunkChain;
        await chain;
      } while (chain !== state.chunkChain);
      if (state.saveError) throw state.saveError;
      info = await api.recordingFinish(state.recordingId, meta);
      state.recordingId = null;
    } else {
      const blob = new Blob(state.chunks, { type: 'video/webm' });
      if (!blob.size) throw new Error('La grabación quedó vacía.');
      const buffer = await blob.arrayBuffer();
      info = await api.saveRecording(buffer, meta);
      state.chunks = [];
    }

    cleanupCapture();
    $('btnStop').disabled = false;
    $('btnPause').disabled = false;
    $('btnPause').textContent = 'Pausar';
    $('recPaused').classList.add('hidden');
    toast(`Grabación guardada: ${info.title}`, 'ok');
    await loadLibrary();
    if (state.settings.autoLibrary) setView('library');
  } catch (err) {
    cleanupCapture();
    $('btnStop').disabled = false;
    $('btnPause').disabled = false;
    toast(`No se pudo guardar: ${friendlyError(err)}`, 'error');
    console.error(err);
  } finally {
    state.saving = false;
    $('btnRecord').disabled = !state.source;
    renderProfile();
    syncFloatingState();
    showAppWindow();
  }
}

function setRecordingUI(active) {
  $('recPill').classList.toggle('hidden', !active);
  $('btnPause').classList.toggle('hidden', !active);
  $('btnStop').classList.toggle('hidden', !active);
  $('btnRecord').classList.toggle('live', active);
  $('btnRecord').disabled = active;
  $('chipSource').disabled = active;
  $('chipCrop').disabled = active;
  $('chipCam').disabled = active;
  $('chipSys').disabled = active;
  $('camSelect').disabled = active;
  $('micModeSelect').disabled = active;
  $('countdownSelect').disabled = active;
  renderProfile();
}

function cleanupCapture() {
  stopDrawing();
  stopTimer();
  api.watchMicHold(false).catch(() => {});
  if (state.micStream || state.analyser) detachMic();
  else stopMicMeter();
  state.micLive = false;
  state.micStarting = false;
  state.micPinned = false;
  state.holdTalk = false;

  [state.displayStream, state.micStream, state.camStream].forEach((stream) => {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  });
  if (state.audioCtx) state.audioCtx.close().catch(() => {});

  state.displayStream = null;
  state.micStream = null;
  state.camStream = null;
  state.screenVideo = null;
  state.camVideo = null;
  state.audioCtx = null;
  state.audioDestination = null;
  state.micSource = null;
  state.micGain = null;
  state.micSilentGain = null;
  state.analyser = null;
  state.recorder = null;
  state.canvasTrack = null;

  const sessionId = state.recordingId;
  state.recordingId = null;
  if (sessionId) api.recordingCancel(sessionId).catch(() => {});
  state.chunkChain = Promise.resolve();
  state.saveError = null;
  state.chunks = [];

  const stage = $('stage');
  stage.classList.remove('recording');
  if (state.source) stage.classList.add('has-source');
  $('recPill').classList.add('hidden');
  $('btnPause').classList.add('hidden');
  $('btnStop').classList.add('hidden');
  $('btnRecord').classList.remove('live');
  $('btnRecord').disabled = !state.source;
  renderProfile();
  $('chipCam').disabled = false;
  $('chipSys').disabled = false;
  $('camSelect').disabled = false;
  $('micModeSelect').disabled = false;
  $('countdownSelect').disabled = false;
  showStageLoading(false);
  updateMicChip();
}

/* ---------------- library ---------------- */

const thumbCache = new Map();
const thumbTasks = new WeakMap();
const thumbQueue = [];
let thumbActive = 0;
let thumbObserver = null;

async function loadLibrary() {
  try {
    state.library = await api.listLibrary();
  } catch (err) {
    state.library = [];
    console.error(err);
  }
  const currentFiles = new Set(state.library.map((item) => item.file));
  for (const key of thumbCache.keys()) {
    if (!currentFiles.has(key)) thumbCache.delete(key);
  }
  $('libSub').textContent = `${state.library.length} grabación${state.library.length === 1 ? '' : 'es'}`;
  renderLibrary();
}

function renderLibrary() {
  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  const grid = $('libraryGrid');
  grid.innerHTML = '';
  const query = state.filter.trim().toLowerCase();
  const items = state.library.filter((item) => !query || item.title.toLowerCase().includes(query));

  const isEmpty = state.library.length === 0;
  $('emptyLib').classList.toggle('hidden', !isEmpty);
  grid.classList.toggle('hidden', isEmpty);

  if (isEmpty) return;
  if (!items.length) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.style.gridColumn = '1 / -1';
    box.innerHTML = '<h2>Sin resultados</h2><p>Prueba con otro término de búsqueda.</p>';
    grid.appendChild(box);
    return;
  }

  items.forEach((item) => grid.appendChild(renderCard(item)));
}

function renderCard(item) {
  const card = document.createElement('article');
  card.className = 'card';

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  thumb.addEventListener('click', () => openPlayer(item));

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  const cachedThumb = item.thumbUrl || thumbCache.get(item.file);
  if (cachedThumb) {
    img.src = cachedThumb;
    img.classList.add('has-thumb');
  } else {
    img.style.display = 'none';
    thumb.classList.add('no-thumb');
    thumb.style.background = 'linear-gradient(135deg, #171b26, #0b0e14)';
    queueThumbnail(item, thumb, img);
  }

  const play = document.createElement('button');
  play.className = 'play';
  play.type = 'button';
  play.setAttribute('aria-label', 'Reproducir');
  play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
  play.addEventListener('click', (event) => {
    event.stopPropagation();
    openPlayer(item);
  });

  const duration = document.createElement('span');
  duration.className = 'duration';
  duration.textContent = formatClock(item.duration);
  duration.classList.toggle('hidden', !item.duration);
  thumb.append(img, play, duration);

  const body = document.createElement('div');
  body.className = 'card-body';
  const title = document.createElement('h3');
  title.textContent = item.title;
  title.title = item.title;
  const meta = document.createElement('p');
  meta.className = 'card-meta';
  meta.textContent = `${formatDate(item.createdAt)} · ${formatBytes(item.size)}`;
  body.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const reveal = actionButton('Mostrar en carpeta', folderIcon(), () => api.revealRecording(item.file));
  const rename = actionButton('Renombrar', pencilIcon(), () => openRename(item));
  const del = actionButton('Eliminar', trashIcon(), () => removeRecording(item));
  del.classList.add('del');
  actions.append(reveal, rename, del);

  card.append(thumb, body, actions);
  return card;
}

function applyThumbnail(thumb, img, url) {
  if (!thumb.isConnected) return;
  img.src = url;
  img.style.display = '';
  img.classList.add('has-thumb');
  thumb.classList.remove('no-thumb');
  thumb.style.background = '';
}

function queueThumbnail(item, thumb, img) {
  const run = () => {
    const cached = thumbCache.get(item.file);
    if (cached) {
      applyThumbnail(thumb, img, cached);
      return;
    }
    thumbQueue.push({ item, thumb, img });
    pumpThumbQueue();
  };

  if (!('IntersectionObserver' in window)) {
    run();
    return;
  }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const task = thumbTasks.get(entry.target);
          thumbObserver?.unobserve(entry.target);
          thumbTasks.delete(entry.target);
          if (task) task();
        }
      },
      { root: null, rootMargin: '240px 0px', threshold: 0.01 },
    );
  }
  thumbTasks.set(thumb, run);
  thumbObserver.observe(thumb);
}

function pumpThumbQueue() {
  while (thumbActive < 2 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (!job.thumb.isConnected) continue;
    thumbActive += 1;
    generateThumbnail(job).finally(() => {
      thumbActive -= 1;
      pumpThumbQueue();
    });
  }
}

function generateThumbnail({ item, thumb, img }) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let finished = false;
    let frameTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (frameTimer) clearTimeout(frameTimer);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      resolve();
    };
    const draw = () => {
      if (finished) return;
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          finish();
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(canvas.width / vw, canvas.height / vh);
        const sw = canvas.width / scale;
        const sh = canvas.height / scale;
        ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', 0.76);
        thumbCache.set(item.file, url);
        if (thumbCache.size > 100) thumbCache.delete(thumbCache.keys().next().value);
        applyThumbnail(thumb, img, url);
      } catch (err) {
        console.warn('VRL thumb draw error', item.file, err?.name, err?.message);
      }
      finish();
    };
    const timeout = setTimeout(() => {
      console.warn('VRL thumb timeout', item.file);
      finish();
    }, 12000);
    const startFrame = () => {
      if (finished) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameTimer = setTimeout(draw, 300);
        video.requestVideoFrameCallback(() => {
          if (frameTimer) clearTimeout(frameTimer);
          draw();
        });
      } else {
        frameTimer = setTimeout(draw, 100);
      }
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;opacity:0;pointer-events:none;';
    video.addEventListener(
      'loadedmetadata',
      () => {
        const duration = Number(video.duration) || 0;
        const time = duration > 0 ? Math.min(Math.max(duration * 0.05, 0.8), 3) : 0.8;
        try {
          video.currentTime = time;
        } catch {
          finish();
        }
      },
      { once: true },
    );
    video.addEventListener(
      'seeked',
      () => {
        startFrame();
      },
      { once: true },
    );
    video.addEventListener(
      'error',
      () => {
        console.warn('VRL thumb error', item.file, video.error?.code, video.error?.message);
        finish();
      },
      { once: true },
    );
    video.src = item.videoUrl;
    document.body.appendChild(video);
  });
}

function actionButton(label, icon, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function folderIcon() {
  return '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
}

function pencilIcon() {
  return '<svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="m13.5 6.5 3 3"/></svg>';
}

function trashIcon() {
  return '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V5h5v2M7 7l.8 12h8.4L17 7M10 11v4M14 11v4"/></svg>';
}

function openPlayer(item) {
  $('playerTitle').textContent = item.title;
  $('playerMeta').textContent = [
    formatDate(item.createdAt),
    item.duration ? formatClock(item.duration) : '',
    formatBytes(item.size),
  ]
    .filter(Boolean)
    .join(' · ');
  const video = $('player');
  video.src = item.videoUrl;
  $('playerModal').classList.remove('hidden');
  $('btnPlayerFolder').onclick = () => api.revealRecording(item.file);
  video.play().catch(() => {});
}

function openRename(item) {
  state.renameTarget = item;
  $('renameInput').value = item.title;
  $('promptModal').classList.remove('hidden');
  setTimeout(() => {
    $('renameInput').focus();
    $('renameInput').select();
  }, 60);
}

async function saveRename() {
  if (!state.renameTarget) return;
  const title = $('renameInput').value.trim();
  if (!title) {
    toast('El título no puede estar vacío.', 'error');
    return;
  }
  try {
    await api.renameRecording(state.renameTarget.file, title);
    closeModal('promptModal');
    state.renameTarget = null;
    await loadLibrary();
    toast('Título actualizado.', 'ok');
  } catch (err) {
    toast(`No se pudo renombrar: ${friendlyError(err)}`, 'error');
  }
}

async function removeRecording(item) {
  const confirmed = window.confirm(`¿Eliminar "${item.title}"? Se enviará a la papelera.`);
  if (!confirmed) return;
  try {
    await api.deleteRecording(item.file);
    await loadLibrary();
    toast('Grabación eliminada.', 'ok');
  } catch (err) {
    toast(`No se pudo eliminar: ${friendlyError(err)}`, 'error');
  }
}

/* ---------------- self test ---------------- */

async function runSelfTest() {
  const result = { ok: false };
  try {
    const sources = await api.listSources();
    const screen = sources.find((source) => source.type === 'screen');
    if (!screen) throw new Error('No hay pantallas disponibles');
    result.source = screen.name;
    await api.selectSource(screen.id, true);

    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch {
      display = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screen.id,
            maxFrameRate: 30,
          },
        },
        audio: false,
      });
    }
    const audioCount = display.getAudioTracks().length;

    const video = await makeVideo(display);
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      if (video.readyState >= 2) ctx.drawImage(video, 0, 0, width, height);
    };
    draw();
    const thumb = canvas.toDataURL('image/jpeg', 0.6);
const stream = canvas.captureStream(15);
    const canvasTrack = stream.getVideoTracks()[0];
    display.getAudioTracks().forEach((track) => stream.addTrack(track));
    const mime = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 4000000,
    });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start(400);
    const started = Date.now();
    while (Date.now() - started < 3000) {
      draw();
      if (canvasTrack && typeof canvasTrack.requestFrame === 'function') canvasTrack.requestFrame();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    recorder.stop();
    await stopped;
    display.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: 'video/webm' });
    const info = await api.saveRecording(await blob.arrayBuffer(), {
      title: 'self-test',
      duration: 3,
      thumb,
      width,
      height,
    });
    result.ok = info.size > 2000;
    result.file = info.file;
    result.size = info.size;
    result.width = width;
    result.height = height;
    result.mime = mime;
    result.chunks = chunks.length;
    result.displayAudioTracks = audioCount;
  } catch (err) {
    result.error = err?.stack || String(err);
  }
  await api.selfTestDone(result);
}

/* ---------------- boot ---------------- */

async function boot() {
  if (SELFTEST) {
    document.body.classList.add('selftest');
    window.__vrlSelfTestStart = runSelfTest;
    try {
      const info = await api.info();
      $('recDir').textContent = info.recDir;
    } catch {
      /* noop */
    }
    return;
  }

  syncSettingsUI();
  bindSettings();
  renderProfile();
  syncFloatingState();
  setView('record');
  schedulePrimeDevices();

  try {
    const info = await api.info();
    $('recDir').textContent = info.recDir;
    $('appVersion').textContent = `v${info.version}`;
    if (info.lowEnd) document.body.classList.add('low-end');
    if (info.freeSpace > 0 && info.freeSpace < 4 * 1024 ** 3) {
      const gb = (info.freeSpace / 1024 ** 3).toFixed(1);
      toast(`Quedan ${gb} GB libres en disco. Libera espacio antes de grabar.`, 'error');
    }
  } catch {
    /* noop */
  }

  window.addEventListener('beforeunload', cleanupCapture);

  if (CROP_TEST) window.__vrlCropTest = runCropTest;
  if (MIC_TEST) window.__vrlMicTest = runMicTest;
}

function probeVideoFile(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const finish = (value) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);
    video.preload = 'metadata';
    video.onloadedmetadata = () =>
      finish({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number(video.duration) || 0,
      });
    video.onerror = () => finish(null);
    video.src = url;
  });
}

async function runCropTest() {
  try {
    const sources = await api.listSources();
    const screen = sources.find((item) => item.type === 'screen');
    if (!screen) throw new Error('No hay pantallas disponibles.');

    await chooseSource(screen);
    await openCropModal();
    await new Promise((resolve) => setTimeout(resolve, 5000));

    setCropRectFromState('center');
    const img = $('cropImage');
    const presetLabel = $('cropSize').textContent;

    const handle = $('cropBox').querySelector('.crop-handle.se');
    const startX = 600;
    const startY = 400;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: startX, clientY: startY }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: startX - 180, clientY: startY - 120 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: startX - 180, clientY: startY - 120 }),
    );

    const beforeApply = {
      label: $('cropSize').textContent,
      presetLabel,
      client: { width: img.clientWidth, height: img.clientHeight },
      natural: { width: img.naturalWidth, height: img.naturalHeight },
      rect: state.cropRectPx ? { ...state.cropRectPx } : null,
      snapshot: state.cropSnapshot
        ? { width: state.cropSnapshot.width, height: state.cropSnapshot.height }
        : null,
    };
    $('btnCropApply').click();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterApply = {
      crop: state.crop ? { ...state.crop } : null,
      chip: $('cropLabel').textContent,
      thumb: $('stageThumb').src.slice(0, 30),
      settings: { lastCrop: state.settings.lastCrop },
      hidden: $('cropModal').classList.contains('hidden'),
      client: { width: img.clientWidth, height: img.clientHeight },
    };

    const crop = state.crop ? { ...state.crop } : null;
    const chip = $('cropLabel').textContent;
    const previewCropped = $('stageThumb').src.startsWith('data:image/jpeg');

    state.settings.countdown = 0;
    state.settings.profile = 'class';
    state.settings.micMode = 'off';
    state.settings.systemAudio = true;
    state.settings.autoLibrary = false;
    const before = state.library.length;

    await startRecording();
    const canvas = { width: state.width, height: state.height };
    const native = { width: state.nativeWidth, height: state.nativeHeight };
    await new Promise((resolve) => setTimeout(resolve, 1400));
    stopRecording();

    for (let i = 0; i < 60 && state.library.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const item = state.library.find((entry) => entry.title === state.recordingTitle) || state.library[0];
    const probe = item ? await probeVideoFile(item.videoUrl) : null;
    const dragWorked =
      Boolean(beforeApply.rect) && beforeApply.rect.w < beforeApply.client.width - 100;
    return {
      ok:
        Boolean(crop) &&
        dragWorked &&
        Boolean(item) &&
        item.size > 0 &&
        Boolean(probe) &&
        probe.width === canvas.width &&
        probe.height === canvas.height,
      selectionLabel: beforeApply.presetLabel,
      dragWorked,
      beforeApply,
      afterApply,
      chip,
      crop,
      canvas,
      native,
      previewCropped,
      saved: item
        ? {
            width: probe?.width || 0,
            height: probe?.height || 0,
            duration: probe?.duration || 0,
            size: item.size,
            file: item.file,
          }
        : null,
    };
  } catch (err) {
    return { ok: false, error: err?.stack || String(err) };
  }
}

async function runMicTest() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const sources = await api.listSources();
    const screen = sources.find((item) => item.type === 'screen');
    if (!screen) throw new Error('No hay pantallas disponibles.');
    await chooseSource(screen);

    state.settings.countdown = 0;
    state.settings.profile = 'class';
    state.settings.micMode = 'off';
    state.settings.systemAudio = true;
    state.settings.autoLibrary = false;

    const beforeLibrary = state.library.length;
    await startRecording();
    if (!state.recording) throw new Error('La grabación no inició.');
    await sleep(800);

    const initial = {
      live: state.micLive,
      stream: Boolean(state.micStream),
      label: $('micLabel').textContent,
      audioTracks: state.recorder.stream.getAudioTracks().length,
    };

    $('chipMic').click();
    for (let i = 0; i < 50 && !state.micLive; i += 1) await sleep(120);
    const clickOn = {
      live: state.micLive,
      stream: Boolean(state.micStream),
      micTracks: state.micStream ? state.micStream.getAudioTracks().length : 0,
      analyser: Boolean(state.analyser),
      label: $('micLabel').textContent,
    };

    await sleep(700);
    $('chipMic').click();
    await sleep(250);
    const clickOff = {
      live: state.micLive,
      stream: Boolean(state.micStream),
      label: $('micLabel').textContent,
    };

    await beginHoldTalk();
    for (let i = 0; i < 50 && !state.micLive; i += 1) await sleep(120);
    const holdOn = {
      live: state.micLive,
      pinned: state.micPinned,
      label: $('micLabel').textContent,
    };

    await sleep(500);
    endHoldTalk();
    await sleep(250);
    const holdOff = {
      live: state.micLive,
      stream: Boolean(state.micStream),
      label: $('micLabel').textContent,
    };

    await sleep(400);
    stopRecording();
    for (let i = 0; i < 60 && state.library.length === beforeLibrary; i += 1) await sleep(200);
    const item = state.library.find((entry) => entry.title === state.recordingTitle) || state.library[0];
    const probe = item ? await probeVideoFile(item.videoUrl) : null;

    return {
      ok:
        initial.live === false &&
        initial.audioTracks === 1 &&
        clickOn.live === true &&
        clickOn.micTracks > 0 &&
        clickOn.analyser === true &&
        clickOff.live === false &&
        clickOff.stream === false &&
        holdOn.live === true &&
        holdOn.pinned === false &&
        holdOff.live === false &&
        holdOff.stream === false &&
        Boolean(item) &&
        item.size > 0 &&
        Boolean(probe),
      initial,
      clickOn,
      clickOff,
      holdOn,
      holdOff,
      saved: item
        ? {
            width: probe?.width || 0,
            height: probe?.height || 0,
            duration: probe?.duration || 0,
            size: item.size,
            file: item.file,
          }
        : null,
    };
  } catch (err) {
    return { ok: false, error: err?.stack || String(err) };
  }
}

boot();
