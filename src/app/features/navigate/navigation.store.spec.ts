import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_ROUTING_CONFIG,
  LatLng,
  MAP_ROUTING_CONFIG,
  MapProvider,
  MapProviderService,
  RouteResult,
  RouteStep,
  RoutingFacade,
  destinationPoint,
  distanceMeters,
  totalDistanceMeters,
} from '../../core/map';
import { DeliveryMockApi } from '../delivery/delivery-mock.api';
import { DeliveryStop, DeliveryTrip } from '../delivery/delivery.models';
import { NavigationStore } from './navigation.store';

/**
 * ================== KIỂM CHỨNG CHẾ ĐỘ DẪN ĐƯỜNG ==================
 *
 * Ba thứ dễ làm sai nhất, và cũng là ba thứ mà người dùng phát hiện ngay:
 *
 *  1. Tuyến dẫn đường phải đi qua ĐÚNG các điểm chưa giao rồi mới về kho.
 *  2. Giao xong một điểm thì tuyến mới phải bắt đầu từ CHỖ XE ĐANG ĐỨNG,
 *     không phải từ kho, và điểm vừa giao phải biến khỏi danh sách.
 *  3. Tới nơi phải được nhận biết tự động và xe phải DỪNG lại chờ xác nhận —
 *     không được chạy vượt qua cửa hàng.
 */

const DEPOT = { name: 'Kho test', address: '—', lat: 21.0, lng: 105.8 };

/** Hai điểm giao nằm trên một đường thẳng hướng đông, cách kho 200 m và 400 m. */
function makeStops(): DeliveryStop[] {
  return [1, 2].map((i) => {
    const p = destinationPoint(DEPOT, 90, i * 200);
    return {
      id: `S${i}`,
      seq: i,
      orderCode: `DH-${i}`,
      customerName: `KH ${i}`,
      address: `Địa chỉ ${i}`,
      lat: p.lat,
      lng: p.lng,
      plannedArrival: `2026-09-09T0${6 + i}:00:00.000Z`,
      actualArrival: null,
      status: 'pending' as const,
      amount: 1_000_000 * i,
    };
  });
}

function makeTrip(): DeliveryTrip {
  return {
    id: 'T1',
    code: 'TRIP-TEST',
    date: '2026-09-09',
    driverName: 'Tài xế test',
    driverPhone: '0900000000',
    vehiclePlate: '29A-00000',
    depot: DEPOT,
    stops: makeStops(),
    track: [],
  };
}

function step(instruction: string, meters: number): RouteStep {
  return {
    instruction,
    roadName: instruction,
    distanceMeters: meters,
    durationSeconds: meters / 20,
    location: DEPOT,
    maneuver: 'turn',
    modifier: 'right',
  };
}

/**
 * Định tuyến giả: nối thẳng các điểm, 20 m/s.
 * Có `legs` (để tính "còn bao xa tới điểm kế tiếp") và `steps` (băng chỉ dẫn).
 */
const computeRoute = vi.fn(
  async ({
    points,
  }: {
    points: readonly LatLng[];
    withSteps?: boolean;
  }): Promise<RouteResult> => {
    const distance = totalDistanceMeters(points);
    return {
      path: [...points],
      distanceMeters: distance,
      durationSeconds: distance / 20,
      legs: points.slice(1).map((p, i) => ({
        distanceMeters: distanceMeters(points[i], p),
        durationSeconds: distanceMeters(points[i], p) / 20,
      })),
      steps: points.slice(1).map((p, i) => step(`Chặng ${i + 1}`, distanceMeters(points[i], p))),
    };
  },
);

class FakeApi {
  getTrip = vi.fn(async (id: string) => ({ ...makeTrip(), id, code: `TRIP-${id}` }));
  listTrips = () => [
    { id: 'T1', code: 'TRIP-TEST', driverName: 'Tài xế test', vehiclePlate: '29A-00000' },
    { id: 'T2', code: 'TRIP-KHAC', driverName: 'Tài xế khác', vehiclePlate: '29A-11111' },
  ];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  computeRoute.mockClear();

  TestBed.configureTestingModule({
    providers: [
      { provide: MAP_ROUTING_CONFIG, useValue: DEFAULT_MAP_ROUTING_CONFIG },
      { provide: DeliveryMockApi, useClass: FakeApi },
      { provide: RoutingFacade, useValue: { computeRoute, providerDrawsOwnRoute: () => false } },
      {
        provide: MapProviderService,
        useValue: { provider: () => MapProvider.OpenStreet, missingKey: () => false },
      },
      NavigationStore,
    ],
  });

  const store = TestBed.inject(NavigationStore);
  await TestBed.inject(ApplicationRef).whenStable();
  return store;
}

const stable = () => TestBed.inject(ApplicationRef).whenStable();

describe('NavigationStore — dẫn đường tài xế', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('tuyến đầu tiên: kho -> các điểm chưa giao -> về kho, có xin chỉ dẫn rẽ', async () => {
    const store = await setup();

    expect(store.waypoints().map((w) => w.stop?.id ?? 'depot')).toEqual(['S1', 'S2', 'depot']);

    const [arg] = computeRoute.mock.calls.at(-1)!;
    expect(arg.points.length).toBe(4); // kho + 2 điểm + kho
    expect(arg.withSteps).toBe(true);
    expect(distanceMeters(arg.points[0], DEPOT)).toBeLessThan(1);

    // Chưa chạy thì xe đứng ở kho và chỉ dẫn đã sẵn sàng.
    expect(distanceMeters(store.position(), DEPOT)).toBeLessThan(30);
    expect(store.guidance()).not.toBeNull();
    expect(store.nextWaypoint()?.stop?.id).toBe('S1');
  });

  it('"còn bao xa tới điểm kế tiếp" đo dọc tuyến, không phải toàn bộ quãng đường còn lại', async () => {
    const store = await setup();

    // Tuyến: 200 + 200 + 400 = 800 m; điểm kế tiếp cách 200 m.
    expect(store.metersToNextStop()).toBeCloseTo(200, -1);
    expect(store.metersRemaining()).toBeCloseTo(800, -1);
    expect(store.secondsToNextStop()).toBeGreaterThan(0);
  });

  it('định tuyến lại thì xuất phát từ vị trí xe, không phải từ kho', async () => {
    const store = await setup();
    const before = store.rerouteCount();

    store.reroute();
    await stable();

    expect(store.rerouteCount()).toBe(before + 1);

    const [arg] = computeRoute.mock.calls.at(-1)!;
    // Điểm đầu là vị trí hiện tại (có nhiễu GPS quanh kho) chứ không phải toạ độ kho.
    expect(arg.points.length).toBe(4);
    expect(store.log()[0]?.text).toContain('Định tuyến lại');
  });

  it('tự nhận biết đã tới nơi, DỪNG xe lại chờ xác nhận', async () => {
    const store = await setup();

    store.setSpeed(16); // 16 giây mô phỏng mỗi nhịp 0,5 s -> ~160 m/nhịp
    store.start();
    await stable();

    // 200 m tới điểm đầu -> tối đa vài nhịp.
    for (let i = 0; i < 12 && !store.arrivedStop(); i++) {
      await wait(TICK_WAIT_MS);
      await stable();
    }

    expect(store.arrivedStop()?.id).toBe('S1');
    expect(store.running()).toBe(false);
    expect(store.log().some((l) => l.kind === 'arrive')).toBe(true);
  });

  it('giao xong -> điểm biến khỏi tuyến và tính lại đường từ chỗ đang đứng', async () => {
    const store = await setup();

    store.setSpeed(16);
    store.start();
    await stable();

    for (let i = 0; i < 12 && !store.arrivedStop(); i++) {
      await wait(TICK_WAIT_MS);
      await stable();
    }
    expect(store.arrivedStop()).not.toBeNull();

    const positionAtStop = store.position();
    store.completeArrivedStop();
    await stable();
    store.pause();

    expect(store.doneStopIds().has('S1')).toBe(true);
    expect(store.waypoints().map((w) => w.stop?.id ?? 'depot')).toEqual(['S2', 'depot']);

    const [arg] = computeRoute.mock.calls.at(-1)!;
    expect(arg.points.length).toBe(3); // vị trí hiện tại + S2 + kho
    // Tuyến mới KHÔNG được bắt đầu lại từ kho.
    expect(distanceMeters(arg.points[0], positionAtStop)).toBeLessThan(30);
    expect(distanceMeters(arg.points[0], DEPOT)).toBeGreaterThan(100);
  });

  it('đặt lại phiên trả mọi thứ về trạng thái ban đầu', async () => {
    const store = await setup();

    store.setSpeed(16);
    store.start();
    await stable();
    await wait(TICK_WAIT_MS);

    store.resetSession();
    await stable();

    expect(store.running()).toBe(false);
    expect(store.doneStopIds().size).toBe(0);
    expect(store.arrivedStop()).toBeNull();
    expect(store.log()).toEqual([]);
    expect(distanceMeters(store.position(), DEPOT)).toBeLessThan(30);
  });
});

/**
 * ============ TUYẾN CŨ ĐƯỢC GIỮ LÀM NỀN, NHƯNG CHỈ TRONG CÙNG MỘT CHUYẾN ============
 *
 * `resource` xoá `value()` ngay khi bắt đầu tải lần mới. Nếu không giữ tuyến cũ
 * làm nền thì mỗi lần định tuyến lại, `routePath()` rỗng vài trăm mili-giây và
 * vị trí xe rơi về `{0,0}` — marker biến mất khỏi bản đồ.
 *
 * Nhưng giữ vô điều kiện lại sinh lỗi ngược: đổi hẳn sang chuyến khác thì tuyến
 * của chuyến TRƯỚC loé lên bản đồ chuyến mới. Vì nó cũng là một tuyến bám phố
 * bình thường nên không ai nhận ra đó là đường của xe khác.
 */
describe('NavigationStore — tuyến nền không được lẫn giữa hai chuyến', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('định tuyến lại TRONG CÙNG chuyến -> vẫn giữ tuyến cũ, xe không rơi về {0,0}', async () => {
    const store = await setup();
    const pathBefore = store.routePath();
    expect(pathBefore.length).toBeGreaterThan(1);

    store.reroute('test');

    // Ngay sau khi yêu cầu tính lại (resource chưa trả về): tuyến cũ vẫn còn.
    expect(store.routePath().length).toBeGreaterThan(1);
    expect(distanceMeters(store.position(), DEPOT)).toBeLessThan(30);

    await stable();
    expect(store.routePath().length).toBeGreaterThan(1);
  });

  it('ĐỔI HẲN chuyến -> không dùng lại tuyến của chuyến trước', async () => {
    const store = await setup();
    expect(store.routePath().length).toBeGreaterThan(1);

    store.selectTrip('T2');

    // Khoảnh khắc nguy hiểm: tuyến mới chưa về. Không được lấy tuyến T1 lấp vào.
    expect(store.route()).toBeUndefined();
    expect(store.routePath()).toEqual([]);

    await stable();

    // Tuyến mới về thì hiển thị bình thường trở lại.
    expect(store.tripId()).toBe('T2');
    expect(store.routePath().length).toBeGreaterThan(1);
  });

  it('quay lại chuyến cũ vẫn tính tuyến mới, không dùng bộ nhớ đệm lạc chuyến', async () => {
    const store = await setup();

    store.selectTrip('T2');
    await stable();
    store.selectTrip('T1');

    expect(store.route()).toBeUndefined();

    await stable();
    expect(store.tripId()).toBe('T1');
    expect(store.routePath().length).toBeGreaterThan(1);
  });
});

/** Nhịp mô phỏng của store là 500 ms — chờ dư một chút cho chắc. */
const TICK_WAIT_MS = 600;
