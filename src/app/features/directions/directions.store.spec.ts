import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_ROUTING_CONFIG,
  GeocodeFacade,
  LatLng,
  MAP_ROUTING_CONFIG,
  MapProvider,
  MapProviderService,
  RouteResult,
  RoutingFacade,
  TravelMode,
} from '../../core/map';
import { RoutingError } from '../../core/map/routing.error';
import { DirectionsStore } from './directions.store';

/**
 * ============ MÀN CHỈ ĐƯỜNG: ĐỔI PHƯƠNG TIỆN / ĐỔI NGUỒN ============
 *
 * Ba lỗi thật đã gặp trên UI, nay khoá lại bằng test:
 *  1. Chọn xe đạp ra `0 m · 0 phút` mà bản đồ vẫn có đường — do tầng service
 *     bịa ra `RouteResult` rỗng khi Google trả `routes: []`.
 *  2. Đổi phương tiện nhưng số liệu vẫn là của phương tiện trước.
 *  3. Đổi nhà cung cấp bản đồ mà con trỏ "phương án số 3" của nguồn cũ còn giữ
 *     nguyên, trong khi nguồn mới chỉ trả về 1 phương án.
 */

const SEED_COUNT = 3;

interface Call {
  points: readonly LatLng[];
  travelMode?: TravelMode;
}

function makeRoutes(count: number, label: string, meters: number): RouteResult[] {
  return Array.from({ length: count }, (_, i) => ({
    path: [
      { lat: 21.0, lng: 105.8 },
      { lat: 21.01, lng: 105.81 },
      { lat: 21.02, lng: 105.82 },
    ],
    distanceMeters: meters + i * 500,
    durationSeconds: 600 + i * 60,
    steps: [],
    source: {
      provider: MapProvider.OpenStreet,
      label,
      travelMode: 'driving' as TravelMode,
      profile: label,
    },
  }));
}

async function setup() {
  TestBed.resetTestingModule();
  localStorage.clear();

  const calls: Call[] = [];
  let alternativeCount = 3;
  let failure: Error | null = null;

  const computeRoutes = vi.fn(async (request: Call & { travelMode?: TravelMode }) => {
    calls.push({ points: [...request.points], travelMode: request.travelMode });
    if (failure) throw failure;
    return makeRoutes(alternativeCount, `OSRM ${request.travelMode ?? 'driving'}`, 15_000);
  });

  let pendingSnap: ((r: unknown[]) => void) | null = null;
  const snapMany = vi.fn(
    () => new Promise<never[]>((resolve) => (pendingSnap = resolve as (r: unknown[]) => void)),
  );

  TestBed.configureTestingModule({
    providers: [
      { provide: MAP_ROUTING_CONFIG, useValue: DEFAULT_MAP_ROUTING_CONFIG },
      {
        provide: RoutingFacade,
        useValue: { computeRoutes, snap: vi.fn(), snapMany, providerDrawsOwnRoute: () => false },
      },
      {
        provide: GeocodeFacade,
        useValue: { search: () => of([]), reverse: () => of('x'), providerLabel: () => 'fake' },
      },
      MapProviderService,
      DirectionsStore,
    ],
  });

  const store = TestBed.inject(DirectionsStore);
  const provider = TestBed.inject(MapProviderService);
  await TestBed.inject(ApplicationRef).whenStable();

  return {
    store,
    provider,
    calls,
    computeRoutes,
    settle: () => TestBed.inject(ApplicationRef).whenStable(),
    setAlternativeCount: (n: number) => (alternativeCount = n),
    setFailure: (e: Error | null) => (failure = e),
    resolveSnap: (results: unknown[]) => pendingSnap?.(results),
    snapMany,
  };
}

describe('DirectionsStore — đổi phương tiện', () => {
  beforeEach(() => localStorage.clear());

  it.each<TravelMode>(['driving', 'motorbike', 'cycling', 'walking'])(
    'chọn "%s" thì tính lại tuyến bằng đúng phương tiện đó',
    async (mode) => {
      const { store, calls, settle } = await setup();

      store.setTravelMode(mode);
      await settle();

      expect(calls[calls.length - 1].travelMode).toBe(mode);
      // Không được bỏ điểm nào khi đổi phương tiện.
      expect(calls[calls.length - 1].points.length).toBe(SEED_COUNT);
    },
  );

  it('mỗi lần đổi phương tiện là một request mới, không tái dùng số liệu cũ', async () => {
    const { store, computeRoutes, settle } = await setup();
    const before = computeRoutes.mock.calls.length;

    store.setTravelMode('walking');
    await settle();
    store.setTravelMode('cycling');
    await settle();

    expect(computeRoutes.mock.calls.length).toBe(before + 2);
  });
});

describe('DirectionsStore — không có tuyến thì báo lỗi, không hiện 0 m', () => {
  beforeEach(() => localStorage.clear());

  it('provider không tìm được tuyến -> error rõ ràng, không có path giả', async () => {
    const { store, setFailure, settle } = await setup();

    setFailure(
      new RoutingError('NO_ROUTE', 'Không tìm được lộ trình xe đạp cho các điểm đã chọn.'),
    );
    store.setTravelMode('cycling');
    await settle();

    expect(store.error()).toContain('Không tìm được lộ trình xe đạp');
    // Đây là điểm mấu chốt: KHÔNG được vừa 0 m vừa có đường vẽ.
    expect(store.routePath().length).toBeLessThan(2);
    expect(store.distanceMeters()).toBe(0);
    expect(store.alternatives()).toEqual([]);
  });

  it('số liệu của phương tiện cũ không dính sang phương tiện mới khi lỗi', async () => {
    const { store, setFailure, settle } = await setup();

    await settle();
    expect(store.distanceMeters()).toBeGreaterThan(0);

    setFailure(new RoutingError('NO_ROUTE', 'Không có tuyến đi bộ.'));
    store.setTravelMode('walking');
    await settle();

    expect(store.distanceMeters()).toBe(0);
    expect(store.durationSeconds()).toBe(0);
    expect(store.eta()).toBe('');
  });
});

describe('DirectionsStore — con trỏ phương án khi đổi nguồn', () => {
  beforeEach(() => localStorage.clear());

  it('đổi nhà cung cấp bản đồ -> con trỏ phương án về 0', async () => {
    const { store, provider, settle } = await setup();

    store.selectRoute(2);
    expect(store.routeIndex()).toBe(2);

    provider.setProvider(MapProvider.Google);
    await settle();

    expect(store.routeIndex()).toBe(0);
  });

  it('nguồn mới chỉ có 1 phương án -> không giữ lại index 2 của nguồn cũ', async () => {
    const { store, provider, setAlternativeCount, settle } = await setup();

    store.selectRoute(2);
    setAlternativeCount(1);
    provider.setProvider(MapProvider.Google);
    await settle();

    expect(store.routeIndex()).toBe(0);
    expect(store.alternatives().length).toBe(1);
    // Số liệu hiển thị phải khớp đúng phương án đang chọn.
    expect(store.distanceMeters()).toBe(store.alternatives()[0].distanceMeters);
  });

  it('đổi phương tiện cũng đưa con trỏ về 0', async () => {
    const { store, settle } = await setup();

    store.selectRoute(1);
    store.setTravelMode('walking');
    await settle();

    expect(store.routeIndex()).toBe(0);
  });

  it('hiện nhãn NGUỒN ĐỊNH TUYẾN, không lẫn với nguồn geocode', async () => {
    const { store, settle } = await setup();
    await settle();

    expect(store.routingSourceLabel()).toBe('OSRM driving');
    expect(store.geocodeProviderLabel()).toBe('fake');
  });
});

describe('DirectionsStore — bám đường không gắn nhầm điểm', () => {
  beforeEach(() => localStorage.clear());

  /**
   * `snapMany` là hàng chục request nối tiếp. Bản cũ ghép kết quả theo CHỈ SỐ
   * mảng, nên chỉ cần người dùng đảo thứ tự trong lúc chờ là toạ độ bám đường
   * của điểm này bị gán cho điểm kia — hai ghim nhảy sang chỗ của nhau.
   */
  it('đảo thứ tự trong lúc chờ -> kết quả vẫn về đúng điểm của nó', async () => {
    const { store, resolveSnap } = await setup();

    const [first, second, third] = store.waypoints();
    const running = store.snapAll();

    // Người dùng đảo điểm 1 và 2 trong lúc đang chờ mạng.
    store.move(second.id, -1);
    expect(store.waypoints().map((w) => w.id)).toEqual([second.id, first.id, third.id]);

    // Kết quả trả về theo THỨ TỰ GỬI ĐI: first, second, third.
    resolveSnap([
      { matched: true, snapped: { lat: 1, lng: 1 }, offsetMeters: 10, roadName: 'Đường 1' },
      { matched: true, snapped: { lat: 2, lng: 2 }, offsetMeters: 20, roadName: 'Đường 2' },
      { matched: true, snapped: { lat: 3, lng: 3 }, offsetMeters: 30, roadName: 'Đường 3' },
    ]);
    await running;

    const byId = new Map(store.waypoints().map((w) => [w.id, w]));
    expect(byId.get(first.id)!.snapRoadName).toBe('Đường 1');
    expect(byId.get(second.id)!.snapRoadName).toBe('Đường 2');
    expect(byId.get(third.id)!.snapRoadName).toBe('Đường 3');
  });

  it('điểm bị xoá trong lúc chờ -> kết quả của nó bị bỏ, các điểm khác vẫn đúng', async () => {
    const { store, resolveSnap } = await setup();

    const [first, second, third] = store.waypoints();
    const running = store.snapAll();

    store.removeWaypoint(first.id);

    resolveSnap([
      { matched: true, snapped: { lat: 1, lng: 1 }, offsetMeters: 10, roadName: 'Đường 1' },
      { matched: true, snapped: { lat: 2, lng: 2 }, offsetMeters: 20, roadName: 'Đường 2' },
      { matched: true, snapped: { lat: 3, lng: 3 }, offsetMeters: 30, roadName: 'Đường 3' },
    ]);
    await running;

    const byId = new Map(store.waypoints().map((w) => [w.id, w]));
    expect(byId.has(first.id)).toBe(false);
    expect(byId.get(second.id)!.snapRoadName).toBe('Đường 2');
    expect(byId.get(third.id)!.snapRoadName).toBe('Đường 3');
  });

  it('điểm thêm mới trong lúc chờ -> không bị gán nhầm kết quả của điểm khác', async () => {
    const { store, resolveSnap } = await setup();

    const running = store.snapAll();
    store.addWaypoint({ lat: 21.5, lng: 105.5 }, 'Điểm mới');
    const added = store.waypoints()[store.waypoints().length - 1];

    resolveSnap([
      { matched: true, snapped: { lat: 1, lng: 1 }, offsetMeters: 10, roadName: 'Đường 1' },
      { matched: true, snapped: { lat: 2, lng: 2 }, offsetMeters: 20, roadName: 'Đường 2' },
      { matched: true, snapped: { lat: 3, lng: 3 }, offsetMeters: 30, roadName: 'Đường 3' },
    ]);
    await running;

    const fresh = store.waypoints().find((w) => w.id === added.id)!;
    expect(fresh.snapRoadName).toBeUndefined();
    expect(fresh.lat).toBe(21.5);
  });
});
