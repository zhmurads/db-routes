// Карта маршрута на Leaflet + тайлы OpenStreetMap.
// Leaflet подгружается отдельным чанком только при первом раскрытии маршрута.
import type * as Leaflet from 'leaflet';
import type { Journey, Leg, Pos } from './api';
import { hhmm } from './render';

type L = typeof Leaflet;

// Один элемент карты на всю страницу: при перерисовке списка его переносят
// в раскрытую карточку, поэтому зум и положение карты не сбрасываются.
export const mapEl = document.createElement('div');
mapEl.className = 'map';
mapEl.setAttribute('aria-label', 'Карта маршрута');

let lib: L | null = null;
let map: Leaflet.Map | null = null;
let layer: Leaflet.LayerGroup | null = null;
let shownId: string | null = null;

const COLORS: Record<string, string> = {
  ice: '#c40f1e',
  ic: '#39424e',
  regional: '#6b7280',
  sbahn: '#408335',
  city: '#814997',
  other: '#2563eb',
  walk: '#8a8f98',
};

// Google polyline → координаты (precision 6 у MOTIS v2+).
export function decodePolyline(str: string, precision: number): Pos[] {
  const factor = 10 ** precision;
  const out: Pos[] = [];
  let lat = 0, lon = 0, i = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

function legLine(l: Leg): Pos[] {
  if (l.geometry?.points) return decodePolyline(l.geometry.points, l.geometry.precision);
  // Без геометрии — прямые отрезки через остановки.
  return [l.originPos, ...l.stopovers.map((s) => s.pos), l.destinationPos];
}

const timeText = (iso: string | null) => (iso ? hhmm(iso) : '');

async function ensureMap(): Promise<{ L: L; map: Leaflet.Map; layer: Leaflet.LayerGroup }> {
  if (!lib) {
    lib = await import('leaflet');
    await import('leaflet/dist/leaflet.css');
  }
  if (!map) {
    // Дробный зум: иначе fitBounds часто откатывается на целый уровень мельче, чем нужно.
    map = lib.map(mapEl, { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120, scrollWheelZoom: false });
    lib.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">участники OpenStreetMap</a>',
    }).addTo(map);
    map.attributionControl.setPrefix(false);
    // Колесо мыши масштабирует только после клика по карте, чтобы не мешать прокрутке страницы.
    map.on('click', () => map!.scrollWheelZoom.enable());
    map.on('mouseout', () => map!.scrollWheelZoom.disable());
    layer = lib.layerGroup().addTo(map);
    if (import.meta.env.DEV) (window as unknown as { __map: Leaflet.Map }).__map = map;
  }
  return { L: lib, map, layer: layer! };
}

export async function showJourney(j: Journey): Promise<void> {
  const { L, map, layer } = await ensureMap();
  layer.clearLayers();
  const bounds = L.latLngBounds([]);

  for (const l of j.legs) {
    const line = legLine(l);
    line.forEach((p) => bounds.extend(p));
    const color = COLORS[l.walking ? 'walk' : l.product] ?? COLORS.other;
    // Светлая подложка под линией, чтобы она читалась на любой подложке карты.
    if (!l.walking) L.polyline(line, { color: '#fff', weight: 7, opacity: 0.8 }).addTo(layer);
    L.polyline(line, {
      color: l.cancelled ? '#d1121f' : color,
      weight: l.walking ? 3 : 4,
      opacity: 0.95,
      dashArray: l.walking ? '2 6' : l.cancelled ? '8 6' : undefined,
    }).bindTooltip(l.walking ? `Пешком ${l.durationMin} мин` : `${l.line ?? ''}${l.direction ? ' → ' + l.direction : ''}`, { sticky: true })
      .addTo(layer);

    if (l.walking) continue;
    for (const s of l.stopovers) {
      L.circleMarker(s.pos, {
        radius: 3, color, weight: 1.5, fillColor: '#fff', fillOpacity: 1,
      }).bindTooltip(`${s.name} ${timeText(s.arr.actual ?? s.arr.planned ?? s.dep.planned)}`).addTo(layer);
    }
    const end = (pos: Pos, name: string, t: string | null, platform: string | null) =>
      L.circleMarker(pos, { radius: 6, color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${name} ${timeText(t)}${platform ? ', путь ' + platform : ''}`)
        .addTo(layer);
    end(l.originPos, l.origin, l.dep.actual ?? l.dep.planned, l.dep.platform);
    end(l.destinationPos, l.destination, l.arr.actual ?? l.arr.planned, l.arr.platform);
  }

  // Маршрут от/до местоположения пользователя: первый/последний отрезок пешком от точки START/END.
  const first = j.legs[0], last = j.legs[j.legs.length - 1];
  if (first?.walking && first.origin === 'START') {
    L.circleMarker(first.originPos, { radius: 7, color: '#2563eb', weight: 3, fillColor: '#2563eb', fillOpacity: 0.35 })
      .bindTooltip('Вы здесь').addTo(layer);
  }
  if (last?.walking && last.destination === 'END') {
    L.circleMarker(last.destinationPos, { radius: 7, color: '#1b1d22', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip('Пункт назначения').addTo(layer);
  }

  // Старт и финиш крупнее.
  const transit = j.legs.filter((l) => !l.walking);
  if (transit.length) {
    const a = transit[0], b = transit[transit.length - 1];
    L.circleMarker(a.originPos, { radius: 8, color: '#1a7f37', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`Отправление: ${a.origin}`).addTo(layer);
    L.circleMarker(b.destinationPos, { radius: 8, color: '#1b1d22', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`Прибытие: ${b.destination}`).addTo(layer);
  }

  // Элемент мог только что переехать в новую карточку.
  map.invalidateSize({ animate: false });
  // Новый маршрут — подгоняем вид; тот же после автообновления — оставляем как есть.
  if (shownId !== j.id && bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16], animate: false });
  shownId = j.id;
}

// После refresh у маршрута может смениться id — считаем его тем же.
export function keepView(oldId: string, newId: string) {
  if (shownId === oldId) shownId = newId;
}
