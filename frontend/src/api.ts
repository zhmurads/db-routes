// Типы и вызовы backend'а (формат см. backend/src/normalize.ts).

export type Source = 'transitous' | 'db';
export interface TimePoint {
  planned: string | null; actual: string | null; delayMin: number | null;
  platform: string | null; plannedPlatform: string | null; cancelled: boolean; source: Source;
}
export type Pos = [number, number];
export interface Stopover { name: string; pos: Pos; arr: TimePoint; dep: TimePoint; cancelled: boolean }
export interface Geometry { points: string; precision: number }
export interface Warning { title: string; text: string; url: string | null; source: Source }
export interface Leg {
  walking: boolean; mode: string; product: string; line: string | null; number: string | null;
  direction: string | null; operator: string | null; realtime: boolean; cancelled: boolean;
  additional: boolean; stayInVehicle: boolean; durationMin: number; distanceM: number | null;
  origin: string; destination: string; originPos: Pos; destinationPos: Pos; dep: TimePoint; arr: TimePoint;
  stopovers: Stopover[]; warnings: Warning[]; geometry: Geometry | null;
}
export interface Journey {
  id: string; departure: TimePoint; arrival: TimePoint; durationMin: number; transfers: number;
  cancelled: boolean; realtime: boolean; products: string[]; warnings: Warning[]; legs: Leg[];
}
export interface JourneysPage { journeys: Journey[]; earlierRef: string | null; laterRef: string | null }
export interface Station { id: string; name: string; region: string | null; products: string[] }

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<{ data: T; updatedAt: string }> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ''));
  let res: Response;
  try {
    res = await fetch(`/api${path}?${qs}`, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('NETWORK', 'Нет связи с сервером');
  }
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new ApiError(body?.error?.code ?? 'HTTP', body?.error?.message ?? `Ошибка ${res.status}`);
  return body;
}

export const searchStations = (q: string, signal?: AbortSignal) =>
  get<Station[]>('/stations', { q }, signal).then((r) => r.data);

export interface JourneyQuery {
  from: string; to: string; via: string; when: string; mode: 'dep' | 'arr';
  products: string; transferTime: string;
}
export const searchJourneys = (q: JourneyQuery, cursor = '') =>
  get<JourneysPage>('/journeys', { ...q, cursor });

export const refreshJourney = (id: string) => get<Journey>('/journeys/refresh', { id });

export const reverseGeocode = (lat: number, lon: number) =>
  get<{ name: string | null }>('/reverse', { lat: String(lat), lon: String(lon) }).then((r) => r.data.name);
