'use strict';

window.__miniLoaded = true;
window.addEventListener('error', (event) => {
  window.__miniError = event.message;
});

const api = window.mini;
const panel = document.getElementById('panel');
const time = document.getElementById('time');
const status = document.getElementById('status');
const mic = document.getElementById('mic');
const pause = document.getElementById('pause');
const stop = document.getElementById('stop');
const restore = document.getElementById('restore');

const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>';
const PLAY_ICON =
  '<svg class="play-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>';

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

function render(state) {
  const recording = Boolean(state?.recording);
  const saving = Boolean(state?.saving);
  const paused = Boolean(state?.paused);
  const micLive = Boolean(state?.micLive);
  const micStarting = Boolean(state?.micStarting);

  panel.classList.toggle('paused', paused && !saving);
  panel.classList.toggle('saving', saving);
  time.textContent = formatClock(state?.elapsed);
  status.textContent = saving ? 'Guardando' : paused ? 'Pausada' : 'Grabando';
  if (typeof state?.accent === 'string') {
    document.documentElement.style.setProperty('--accent', state.accent);
  }

  pause.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  pause.title = paused ? 'Reanudar grabación' : 'Pausar grabación';
  pause.setAttribute('aria-label', pause.title);
  pause.disabled = !recording || saving;

  mic.classList.toggle('on', micLive);
  mic.title = micStarting
    ? 'Abriendo micrófono'
    : micLive
      ? 'Desactivar micrófono'
      : 'Activar micrófono';
  mic.setAttribute('aria-label', mic.title);
  mic.disabled = !recording || saving || micStarting;

  stop.disabled = !recording || saving;
}

mic.addEventListener('click', () => {
  if (!mic.disabled) api.action('mic');
});

pause.addEventListener('click', () => {
  if (!pause.disabled) api.action('pause');
});

stop.addEventListener('click', () => {
  if (stop.disabled) return;
  stop.disabled = true;
  mic.disabled = true;
  pause.disabled = true;
  panel.classList.add('saving');
  status.textContent = 'Guardando';
  api.action('stop');
});

restore.addEventListener('click', () => {
  api.restore();
});

api.onState(render);
api.getState().then(render).catch(() => {});
window.__miniReady = true;
