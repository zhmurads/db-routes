// Приведение ответов MOTIS 2 (Transitous) к единому формату для фронта.

// --- Входные типы (подмножество схем из openapi.yaml MOTIS) ---
interface MAlert { headerText: string; descriptionText: string; url?: string; severityLevel?: string }
interface MPlace {
  name: string; stopId?: string; parentId?: string; lat: number; lon: number;
  arrival?: string; departure?: string; scheduledArrival?: string; scheduledDeparture?: string;
  track?: string; scheduledTrack?: string; cancelled?: boolean; alerts?: MAlert[];
}
interface MLeg {
  mode: string; from: MPlace; to: MPlace; duration: number;
  startTime: string; endTime: string; scheduledStartTime: string; scheduledEndTime: string;
  realTime: boolean; scheduled: boolean; cancelled?: boolean; headsign?: string;
  displayName?: string; routeShortName?: string; tripShortName?: string; agencyName?: string;
  tripId?: string; intermediateStops?: MPlace[]; alerts?: MAlert[]; distance?: number;
  interlineWithPreviousLeg?: boolean;
  legGeometry?: { points: string; precision: number; length: number };
}
export interface MItinerary { id: string; duration: number; startTime: string; endTime: string; transfers: number; legs: MLeg[] }
export interface MPlan { itineraries: MItinerary[]; previousPageCursor?: string; nextPageCursor?: string }
export interface MMatch { id: string; name: string; type: string; modes?: string[]; areas?: { name: string; adminLevel?: number }[]; importance?: number }

// --- Виды транспорта: наши группы фильтров ↔ режимы MOTIS ---
export const PRODUCT_MODES: Record<string, string[]> = {
  ice: ['HIGHSPEED_RAIL'],
  ic: ['LONG_DISTANCE', 'NIGHT_RAIL'],
  regional: ['REGIONAL_RAIL', 'REGIONAL_FAST_RAIL'],
  sbahn: ['SUBURBAN'],
  city: ['BUS', 'COACH', 'TRAM', 'SUBWAY', 'FERRY', 'FUNICULAR', 'AERIAL_LIFT'],
};
export const PRODUCTS = Object.keys(PRODUCT_MODES);

const productOf = (mode: string): string => {
  for (const [p, modes] of Object.entries(PRODUCT_MODES)) if (modes.includes(mode)) return p;
  return mode === 'WALK' ? 'walk' : 'other';
};

// --- Выходные типы ---
// source: откуда взяты фактические время/путь — поток Transitous или табло DB (Timetables API).
export type Source = 'transitous' | 'db';
export interface TimePoint {
  planned: string | null; actual: string | null; delayMin: number | null;
  platform: string | null; plannedPlatform: string | null; cancelled: boolean; source: Source;
}
// Координаты [широта, долгота].
export type Pos = [number, number];
export interface Stopover { name: string; pos: Pos; arr: TimePoint; dep: TimePoint; cancelled: boolean }
// Линия сегмента в формате Google polyline (есть только в ответе refresh).
export interface Geometry { points: string; precision: number }
export interface Warning { title: string; text: string; url: string | null; source: Source }
export interface Leg {
  walking: boolean; mode: string; product: string; line: string | null; number: string | null;
  direction: string | null; operator: string | null; realtime: boolean; cancelled: boolean;
  additional: boolean; stayInVehicle: boolean; durationMin: number; distanceM: number | null;
  origin: string; destination: string; originPos: Pos; destinationPos: Pos;
  originStopId: string | null; destinationStopId: string | null; dep: TimePoint; arr: TimePoint;
  stopovers: Stopover[]; warnings: Warning[]; geometry: Geometry | null;
}
export interface Journey {
  id: string; departure: TimePoint; arrival: TimePoint; durationMin: number; transfers: number;
  cancelled: boolean; realtime: boolean; products: string[]; warnings: Warning[]; legs: Leg[];
}

const delay = (planned?: string, actual?: string): number | null =>
  planned && actual ? Math.round((Date.parse(actual) - Date.parse(planned)) / 60000) : null;

function point(planned: string | undefined, actual: string | undefined, p: MPlace, realtime: boolean, cancelled = false): TimePoint {
  return {
    planned: planned ?? null,
    actual: realtime ? (actual ?? null) : null,
    delayMin: realtime ? delay(planned, actual) : null,
    platform: p.track ?? null,
    plannedPlatform: p.scheduledTrack ?? p.track ?? null,
    cancelled: cancelled || !!p.cancelled,
    source: 'transitous',
  };
}

const warning = (a: MAlert): Warning => ({ title: a.headerText, text: a.descriptionText, url: a.url ?? null, source: 'transitous' });

function uniqWarnings(list: Warning[]): Warning[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = w.title + '|' + w.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function leg(l: MLeg): Leg {
  const walking = l.mode === 'WALK';
  const cancelled = !!l.cancelled;
  const rt = l.realTime;
  const placeAlerts = [l.from, l.to, ...(l.intermediateStops ?? [])].flatMap((p) => p.alerts ?? []);
  return {
    walking,
    mode: l.mode,
    product: productOf(l.mode),
    line: l.displayName ?? l.routeShortName ?? null,
    number: l.tripShortName && l.tripShortName !== l.displayName ? l.tripShortName : null,
    direction: l.headsign ?? null,
    operator: l.agencyName ?? null,
    realtime: rt,
    cancelled,
    additional: l.scheduled === false,
    stayInVehicle: !!l.interlineWithPreviousLeg,
    durationMin: Math.round(l.duration / 60),
    distanceM: l.distance != null ? Math.round(l.distance) : null,
    origin: l.from.name,
    destination: l.to.name,
    originPos: [l.from.lat, l.from.lon],
    destinationPos: [l.to.lat, l.to.lon],
    originStopId: l.from.stopId ?? null,
    destinationStopId: l.to.stopId ?? null,
    dep: point(l.scheduledStartTime, l.startTime, l.from, rt, cancelled),
    arr: point(l.scheduledEndTime, l.endTime, l.to, rt, cancelled),
    stopovers: (l.intermediateStops ?? []).map((s) => ({
      name: s.name,
      pos: [s.lat, s.lon] as Pos,
      arr: point(s.scheduledArrival, s.arrival, s, rt),
      dep: point(s.scheduledDeparture, s.departure, s, rt),
      cancelled: !!s.cancelled,
    })),
    warnings: uniqWarnings([...(l.alerts ?? []), ...placeAlerts].map(warning)),
    geometry: l.legGeometry?.length
      ? { points: l.legGeometry.points, precision: l.legGeometry.precision }
      : null,
  };
}

export function journey(it: MItinerary): Journey {
  const legs = it.legs.map(leg);
  const transit = legs.filter((l) => !l.walking);
  const first = transit[0] ?? legs[0];
  const last = transit[transit.length - 1] ?? legs[legs.length - 1];
  return {
    id: it.id,
    departure: first.dep,
    arrival: last.arr,
    durationMin: Math.round(it.duration / 60),
    transfers: it.transfers,
    cancelled: transit.some((l) => l.cancelled || l.dep.cancelled || l.arr.cancelled),
    realtime: transit.some((l) => l.realtime),
    products: [...new Set(transit.map((l) => l.product))],
    warnings: uniqWarnings(legs.flatMap((l) => l.warnings)),
    legs,
  };
}

export function plan(p: MPlan) {
  return {
    journeys: p.itineraries.map(journey),
    earlierRef: p.previousPageCursor ?? null,
    laterRef: p.nextPageCursor ?? null,
  };
}

export function station(m: MMatch) {
  const region = m.areas?.find((a) => a.adminLevel === 4)?.name ?? m.areas?.[0]?.name ?? null;
  return {
    id: m.id,
    name: m.name,
    region,
    products: [...new Set((m.modes ?? []).map(productOf))].filter((p) => p !== 'other' && p !== 'walk'),
  };
}
