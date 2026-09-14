/**
 * Sale-complete feedback: a short two-note chime and a check mark that draws
 * itself. Both are made in the browser, with no audio or image files to ship.
 *
 * The sound can be switched off per device (Settings -> Till), and anyone who
 * has asked their system to reduce motion gets the check without the movement.
 */
import { esc, money } from './ui.js';
import { t } from './i18n.js';

const SOUND_KEY = 'absoft-sound';
let audio = null;

/** Product pictures on the till's cards (per device, off until switched on). */
const IMAGES_KEY = 'absoft-pos-images';
export function tileImagesEnabled() {
  try {
    return localStorage.getItem(IMAGES_KEY) === '1';
  } catch {
    return false;
  }
}
export function setTileImages(on) {
  try {
    localStorage.setItem(IMAGES_KEY, on ? '1' : '0');
  } catch {
    /* private window: the choice lasts until reload */
  }
}

export function soundEnabled() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the setting simply does not persist */
  }
}

/**
 * Browsers only let a page start audio from a user gesture. Call this inside the
 * click handler, before any await, so the chime can still play once the sale has
 * been saved.
 */
export function primeAudio() {
  if (!soundEnabled()) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

/** A bright rising two-note chime, about half a second long. */
export function playSaleChime() {
  if (!soundEnabled()) return;
  primeAudio();
  if (!audio) return;

  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = 0.22;
  master.connect(audio.destination);

  // A5 then E6: a fifth apart, which reads as "done" rather than "error".
  [
    [880, 0],
    [1318.51, 0.12],
  ].forEach(([freq, at]) => {
    const tone = audio.createOscillator();
    const shimmer = audio.createOscillator();
    const env = audio.createGain();
    tone.type = 'sine';
    shimmer.type = 'triangle';
    tone.frequency.value = freq;
    shimmer.frequency.value = freq * 2;

    const shimmerGain = audio.createGain();
    shimmerGain.gain.value = 0.12;

    env.gain.setValueAtTime(0.0001, now + at);
    env.gain.exponentialRampToValueAtTime(1, now + at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.7);

    tone.connect(env);
    shimmer.connect(shimmerGain).connect(env);
    env.connect(master);
    tone.start(now + at);
    shimmer.start(now + at);
    tone.stop(now + at + 0.75);
    shimmer.stop(now + at + 0.75);
  });
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A full-screen "sale complete" moment. Resolves when it has finished, so the
 * caller can open the receipt straight after. A click or any key skips it.
 */
export function celebrateSale(sale) {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'sale-done';
    layer.setAttribute('role', 'status');
    layer.innerHTML = `
      <div class="sale-done-card">
        <svg class="sale-done-check" viewBox="0 0 52 52" aria-hidden="true">
          <circle class="ring" cx="26" cy="26" r="24"/>
          <path class="tick" d="M15 27.5 22.5 35 38 18.5"/>
        </svg>
        <div class="sale-done-title">${esc(t('pos.sale_done'))}</div>
        <div class="sale-done-amount">${money(sale.total)}</div>
        <div class="sale-done-doc mono">${esc(sale.doc_no)}</div>
      </div>`;
    document.body.appendChild(layer);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', finish, true);
      layer.classList.add('leaving');
      setTimeout(() => {
        layer.remove();
        resolve();
      }, reducedMotion() ? 0 : 220);
    };

    layer.addEventListener('click', finish);
    document.addEventListener('keydown', finish, true);
    setTimeout(finish, reducedMotion() ? 600 : 1250);
  });
}
