/* Telemetría anónima y orientativa: registra acciones semánticas, nunca contenido completo. */
import { store } from './utils.js';

const CLIENT_KEY = 'vocab-telemetry-client';
const SESSION_KEY = 'vocab-telemetry-session';
const uuid = () => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => {
    const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (value === 'x' ? random : (random & 3) | 8).toString(16);
  });
const clientId = store.get(CLIENT_KEY, '') || uuid();
store.set(CLIENT_KEY, clientId);
let sessionId;
try {
  sessionId = sessionStorage.getItem(SESSION_KEY) || uuid();
  sessionStorage.setItem(SESSION_KEY, sessionId);
} catch { sessionId = uuid(); }

let queue = [];
let timer;

function send(events, beacon = false){
  if (!events.length) return;
  const body = JSON.stringify({ clientId, sessionId, events });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon('api/telemetry/events', new Blob([body], { type:'application/json' }));
    return;
  }
  fetch('api/telemetry/events', {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body, keepalive:true
  }).catch(() => {});
}

function flush(){
  clearTimeout(timer); timer = null;
  const events = queue.splice(0, 50);
  send(events);
  if (queue.length) timer = setTimeout(flush, 1000);
}

export function track(type, data = {}){
  queue.push({ type, ...data });
  if (queue.length >= 20) flush();
  else timer ??= setTimeout(flush, 1000);
}

const observed = new Map(); // tarjeta → época del observer activo
const viewed = new Set();
// Una vista solo cuenta si la tarjeta permanece visible (≥50% del viewport) de forma
// continua durante al menos 5 segundos: el scroll rápido ya no registra card_view.
const VIEW_DELAY_MS = 5000;
const sightings = new Map(); // tarjeta → { observerEpoch:number, intersecting:boolean, timer: id|null }
let cardObserver = null;
let observerEpoch = 0;

function isActiveCard(card, epoch){
  return cardObserver && observerEpoch === epoch && observed.get(card) === epoch && card.isConnected;
}

function cancelSight(card){
  const sight = sightings.get(card);
  if (!sight) return;
  if (sight.timer !== null) { clearTimeout(sight.timer); sight.timer = null; }
  if (!sight.intersecting) sightings.delete(card); // libera tarjetas desmontadas o fuera de vista
}

function scheduleSight(card){
  const sight = sightings.get(card);
  if (!sight || sight.timer !== null || !isActiveCard(card, sight.observerEpoch) || document.hidden) return;
  sight.timer = setTimeout(() => {
    // El timer puede haber quedado encolado mientras se desmontaba o reiniciaba la tarjeta.
    if (sightings.get(card) !== sight || !isActiveCard(card, sight.observerEpoch)
      || document.hidden || !sight.intersecting) return;
    sightings.delete(card);
    const id = card.dataset.id;
    if (viewed.has(id)) return;
    viewed.add(id);
    track('card_view', { entryId:id });
    cardObserver.unobserve(card);
    observed.delete(card);
  }, VIEW_DELAY_MS);
}

function createCardObserver(){
  const epoch = ++observerEpoch;
  const observer = new IntersectionObserver(entries => {
    // disconnect() no descarta callbacks encoladas: solo acepta la instancia aún activa.
    if (cardObserver !== observer || observerEpoch !== epoch) return;
    for (const item of entries) {
      const card = item.target;
      if (!isActiveCard(card, epoch)) continue;
      const previous = sightings.get(card);
      if (previous && previous.observerEpoch !== epoch) {
        cancelSight(card);
        sightings.delete(card);
      }
      const sight = sightings.get(card) || { observerEpoch:epoch, intersecting:false, timer:null };
      sightings.set(card, sight);
      sight.intersecting = item.isIntersecting && item.intersectionRatio >= 0.5;
      if (sight.intersecting) scheduleSight(card);
      else cancelSight(card);
    }
  }, { threshold:0.5 });
  return observer;
}

function replaceCardObserver(cardsToStop){
  const retainedCards = [...observed.keys()].filter(card => !cardsToStop.has(card));
  const previousObserver = cardObserver;

  // Invalida la identidad antes de limpiar: callbacks antiguos ya no pueden tocar estado nuevo.
  cardObserver = null;
  previousObserver?.disconnect();
  for (const card of observed.keys()) {
    cancelSight(card);
    sightings.delete(card);
  }
  for (const card of cardsToStop) observed.delete(card);

  // Re-observar exige una época nueva; las tarjetas retenidas reinician sus cinco segundos.
  if (!retainedCards.length) return;
  cardObserver = createCardObserver();
  for (const card of retainedCards) {
    observed.set(card, observerEpoch);
    cardObserver.observe(card);
  }
}

export function observeCards(root){
  if (!cardObserver) cardObserver = createCardObserver();
  for (const card of root.querySelectorAll('.card[data-id]')) {
    if (!observed.has(card)) {
      observed.set(card, observerEpoch);
      cardObserver.observe(card);
    }
  }
}

// Detiene vistas pendientes antes de desmontar tarjetas. Sin argumento limpia todo el tracker.
export function stopCardViewTracking(root){
  const cards = root
    ? [...observed.keys()].filter(card => card === root || root.contains(card))
    : [...observed.keys()];
  if (cards.length) replaceCardObserver(new Set(cards));
}

// Ocultar la pestaña interrumpe la permanencia; al volver, el conteo de 5 s reinicia.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const card of sightings.keys()) cancelSight(card);
  } else {
    for (const [card, sight] of sightings) if (sight.intersecting) scheduleSight(card);
  }
});

addEventListener('pagehide', () => {
  stopCardViewTracking();
  clearTimeout(timer);
  send(queue.splice(0, 50), true);
});
