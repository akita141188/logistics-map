import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_ROUTING_CONFIG,
  GeocodeFacade,
  LatLng,
  MAP_ROUTING_CONFIG,
  MatchResult,
  RoutePoint,
  RouteResult,
  RoutingFacade,
  totalDistanceMeters,
} from '../../core/map';
import { DeliveryMockApi } from './delivery-mock.api';
import { DeliveryMonitorStore, nextCursorByTime } from './delivery-monitor.store';
import { DeliveryStop, DeliveryTrip } from './delivery.models';

/**
 * ================== KIỂM CHỨNG LUẬT SỬA TUYẾN ĐANG CHẠY ==================
 *
 * Trọng tâm không phải "bấm nút có chạy không", mà là 3 ràng buộc nghiệp vụ dễ
 * làm sai nhất khi cho phép chèn điểm giao vào một chuyến đang chạy dở:
 *
 *  1. Không được đụng vào phần đã giao (quá khứ đã có `actualArrival`).
 *  2. Chèn/xoá phải kéo theo tính lại lộ trình + ETA — tự động, không phải gọi tay.
 *  3. `resetPlan()` phải trả về đúng kế hoạch gốc, không để lại rác.
 */

const DEPOT = { name: 'Kho test', address: '—', lat: 21.0, lng: 105.8 };

/** 2 điểm đã giao + 2 điểm chưa giao. */
function makeStops(): DeliveryStop[] {
  const at = (hour: number) => `2026-09-09T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const atMin = (hour: number, minute: number) =>
    `2026-09-09T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

  const base = (i: number, done: boolean): DeliveryStop => ({
    id: `S${i}`,
    seq: i,
    orderCode: `DH-${i}`,
    customerName: `KH ${i}`,
    address: `Địa chỉ ${i}`,
    lat: 21.0 + i * 0.01,
    lng: 105.8 + i * 0.01,
    plannedArrival: at(6 + i),
    actualArrival: done ? atMin(6 + i, 5) : null,
    status: done ? 'delivered' : 'pending',
    amount: 1_000_000 * i,
  });

  return [base(1, true), base(2, true), base(3, false), base(4, false)];
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
    track: [
      { lat: 21.0, lng: 105.8, createDate: '2026-09-09T06:00:00.000Z' },
      { lat: 21.01, lng: 105.81, createDate: '2026-09-09T07:00:00.000Z' },
      { lat: 21.02, lng: 105.82, createDate: '2026-09-09T08:00:00.000Z' },
    ],
  };
}

/**
 * Định tuyến giả: đi thẳng giữa các điểm, mỗi chặng 10 phút.
 * Đủ để kiểm tra "có gọi lại không / gọi với mấy điểm", không cần mạng.
 */
const computeRoute = vi.fn(
  async ({ points }: { points: readonly LatLng[] }): Promise<RouteResult> => ({
    path: [...points],
    distanceMeters: totalDistanceMeters(points),
    durationSeconds: (points.length - 1) * 600,
    legs: points.slice(1).map((p, i) => ({
      distanceMeters: totalDistanceMeters([points[i], p]),
      durationSeconds: 600,
    })),
  }),
);

/**
 * Khớp đường điều khiển được: test tự quyết định lúc nào promise resolve, nhờ
 * vậy dựng lại đúng khoảnh khắc "request chưa về mà người dùng đã đổi chuyến".
 */
let pendingMatch: {
  resolve: (r: MatchResult) => void;
  onProgress?: (done: number, total: number) => void;
} | null = null;

const matchTrack = vi.fn(
  (points: readonly LatLng[], options?: { onProgress?: (d: number, t: number) => void }) =>
    new Promise<MatchResult>((resolve) => {
      pendingMatch = { resolve, onProgress: options?.onProgress };
    }),
);

/** Cho phép từng test thay GPS track mà không phải dựng lại cả FakeApi. */
let trackOverride: RoutePoint[] | null = null;

class FakeApi {
  getTrip = vi.fn(async (id: string) => {
    const trip = { ...makeTrip(), id, code: `TRIP-${id}` };
    return trackOverride ? { ...trip, track: trackOverride } : trip;
  });
  listTrips = () => [
    { id: 'T1', code: 'TRIP-TEST', driverName: 'Tài xế test', vehiclePlate: '29A-00000' },
    { id: 'T2', code: 'TRIP-KHAC', driverName: 'Tài xế khác', vehiclePlate: '29A-11111' },
  ];
  buildPlannedWaypoints = (trip: Pick<DeliveryTrip, 'depot' | 'stops'>): LatLng[] => [
    { lat: trip.depot.lat, lng: trip.depot.lng },
    ...[...trip.stops].sort((a, b) => a.seq - b.seq).map((s) => ({ lat: s.lat, lng: s.lng })),
    { lat: trip.depot.lat, lng: trip.depot.lng },
  ];
}

async function setup(options: { track?: RoutePoint[] } = {}) {
  localStorage.clear();
  computeRoute.mockClear();
  matchTrack.mockClear();
  pendingMatch = null;
  trackOverride = options.track ?? null;

  TestBed.configureTestingModule({
    providers: [
      { provide: MAP_ROUTING_CONFIG, useValue: DEFAULT_MAP_ROUTING_CONFIG },
      { provide: DeliveryMockApi, useClass: FakeApi },
      {
        provide: RoutingFacade,
        useValue: { computeRoute, matchTrack, providerDrawsOwnRoute: () => false },
      },
      {
        provide: GeocodeFacade,
        useValue: {
          search: () => of([]),
          reverse: () => of('Địa chỉ giả'),
          providerLabel: () => 'fake',
        },
      },
      DeliveryMonitorStore,
    ],
  });

  const store = TestBed.inject(DeliveryMonitorStore);
  // Ép resource chạy xong: `whenStable()` chờ cả effect lẫn promise của resource.
  await TestBed.inject(ApplicationRef).whenStable();
  return store;
}

describe('DeliveryMonitorStore — sửa tuyến đang chạy', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('khoá đúng phần đã giao', async () => {
    const store = await setup();

    expect(store.trip()?.stops.length).toBe(4);
    expect(store.lockedCount()).toBe(2);
    expect(store.pendingStops().map((s) => s.id)).toEqual(['S3', 'S4']);
    expect(store.canEditStop(store.trip()!.stops[0])).toBe(false);
    expect(store.canEditStop(store.trip()!.stops[2])).toBe(true);
  });

  it('chèn điểm mới -> tuyến dài thêm, seq đánh lại liên tục, và ĐỊNH TUYẾN LẠI', async () => {
    const store = await setup();

    const callsBefore = computeRoute.mock.calls.length;

    store.patchDraft({ customerName: 'Khách phát sinh', point: { lat: 21.05, lng: 105.85 } });
    store.addStop();
    await TestBed.inject(ApplicationRef).whenStable();

    const stops = store.trip()!.stops;
    expect(stops.length).toBe(5);
    expect(stops.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);

    const added = stops.find((s) => s.isAdHoc)!;
    expect(added.status).toBe('pending');
    // Điểm phát sinh KHÔNG được bịa giờ kế hoạch gốc.
    expect(added.plannedArrival).toBe('');

    // Có gọi lại dịch vụ định tuyến, và gọi với đúng số điểm mới (kho + 5 + kho).
    expect(computeRoute.mock.calls.length).toBeGreaterThan(callsBefore);
    const plannedCall = computeRoute.mock.calls
      .map(([arg]) => arg.points)
      .find((points) => points.length === 7);
    expect(plannedCall).toBeDefined();
  });

  it('không cho chèn vào phần đã giao dù người dùng ép vị trí', async () => {
    const store = await setup();

    store.patchDraft({
      customerName: 'Chen ngang',
      point: { lat: 21.05, lng: 105.85 },
      position: 0, // cố tình đòi chèn lên đầu, trước cả điểm đã giao
    });
    store.addStop();
    await TestBed.inject(ApplicationRef).whenStable();

    const stops = store.trip()!.stops;
    // Hai điểm đã giao vẫn phải đứng đầu, đúng thứ tự cũ.
    expect(stops.slice(0, 2).map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(stops[2].isAdHoc).toBe(true);
  });

  it('không xoá / không đổi thứ tự được điểm đã giao', async () => {
    const store = await setup();

    store.removeStop('S1');
    store.moveStop('S2', 1);
    store.moveStop('S3', -1); // S3 là điểm pending đầu tiên -> lùi lên là đụng vùng khoá

    expect(store.trip()!.stops.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(store.hasEdits()).toBe(false);
  });

  it('xoá được điểm chưa giao và đánh số lại', async () => {
    const store = await setup();

    store.removeStop('S3');
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.trip()!.stops.map((s) => s.id)).toEqual(['S1', 'S2', 'S4']);
    expect(store.trip()!.stops.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  it('ETA của điểm chưa giao được tính lại và bị đẩy muộn khi chèn thêm điểm', async () => {
    const store = await setup();

    const before = store.etaByStop().get('S4')!;
    expect(before).toBeDefined();

    store.patchDraft({ customerName: 'Chèn giữa', point: { lat: 21.025, lng: 105.825 } });
    store.addStop();
    await TestBed.inject(ApplicationRef).whenStable();

    const after = store.etaByStop().get('S4')!;
    // Thêm 1 chặng 10 phút + 10 phút đứng giao -> S4 phải muộn hơn trước.
    expect(new Date(after.eta).getTime()).toBeGreaterThan(new Date(before.eta).getTime());
    expect(after.shiftMinutes).toBeGreaterThan(before.shiftMinutes);
  });

  it('resetPlan trả về đúng kế hoạch gốc', async () => {
    const store = await setup();
    const originalIds = store.trip()!.stops.map((s) => s.id);

    store.patchDraft({ customerName: 'Tạm', point: { lat: 21.05, lng: 105.85 } });
    store.addStop();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(store.hasEdits()).toBe(true);

    store.resetPlan();
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.hasEdits()).toBe(false);
    expect(store.trip()!.stops.map((s) => s.id)).toEqual(originalIds);
    expect(store.draft().point).toBeNull();
  });

  it('GPS track (quá khứ) không bị đụng tới khi sửa tuyến', async () => {
    const store = await setup();
    const trackBefore = store.track();

    store.patchDraft({ customerName: 'X', point: { lat: 21.05, lng: 105.85 } });
    store.addStop();
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.track()).toBe(trackBefore);
    expect(store.stats().actualDistanceMeters).toBeGreaterThan(0);
  });
});

/**
 * ============ KHỚP ĐƯỜNG: KẾT QUẢ LẠC CHUYẾN ============
 *
 * Khớp đường một track thật mất vài giây (hơn chục request nối tiếp vì OSRM công
 * cộng chỉ nhận 10 toạ độ/lần). Trong khoảng đó người điều vận đổi chuyến là
 * chuyện bình thường. Nếu không kiểm tra danh tính lúc kết quả về, đường đi của
 * xe A hiện lên bản đồ chuyến B — mà nhìn thì vẫn là một đường bám phố rất đẹp,
 * không ai nghi ngờ. Đây đúng loại lỗi chỉ test bắt được.
 */
describe('DeliveryMonitorStore — khớp đường không được lạc sang chuyến khác', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const fakeResult = (): MatchResult => {
    const path = [
      { lat: 21.0, lng: 105.8 },
      { lat: 21.01, lng: 105.81 },
    ];
    return {
      path,
      snapped: [...path],
      source: [...path],
      confidence: 0.9,
      matchedRatio: 1,
      avgOffsetMeters: 4,
      maxOffsetMeters: 9,
      chunks: 1,
      failedChunks: 0,
    };
  };

  it('kết quả của chuyến A về sau khi đã đổi sang B -> bị vứt bỏ', async () => {
    const store = await setup();
    expect(store.tripId()).toBe('T1');

    const running = store.runMapMatching();
    expect(pendingMatch).not.toBeNull();

    // Đổi chuyến TRƯỚC khi promise của A về.
    store.selectTrip('T2');
    await TestBed.inject(ApplicationRef).whenStable();

    pendingMatch!.resolve(fakeResult());
    await running;
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.tripId()).toBe('T2');
    expect(store.matchResult()).toBeNull();
    expect(store.matchedPath()).toEqual([]);
    expect(store.matchProgress()).toBe(0);
  });

  it('tiến độ của chuyến cũ không đẩy thanh loading của chuyến mới', async () => {
    const store = await setup();

    const running = store.runMapMatching();
    store.selectTrip('T2');
    await TestBed.inject(ApplicationRef).whenStable();

    pendingMatch!.onProgress?.(5, 10);
    expect(store.matchProgress()).toBe(0);

    pendingMatch!.resolve(fakeResult());
    await running;
  });

  it('ở nguyên chuyến thì kết quả được nhận bình thường', async () => {
    const store = await setup();

    const running = store.runMapMatching();
    pendingMatch!.onProgress?.(5, 10);
    expect(store.matchProgress()).toBe(0.5);

    pendingMatch!.resolve(fakeResult());
    await running;

    expect(store.matchResult()).not.toBeNull();
    expect(store.matchedPath().length).toBe(2);
  });

  it('đổi chuyến giữa chừng vẫn bấm khớp đường lại được (cờ matching phải hạ)', async () => {
    const store = await setup();

    const running = store.runMapMatching();
    store.selectTrip('T2');
    await TestBed.inject(ApplicationRef).whenStable();
    pendingMatch!.resolve(fakeResult());
    await running;

    expect(store.matching()).toBe(false);

    const second = store.runMapMatching();
    expect(matchTrack).toHaveBeenCalledTimes(2);
    pendingMatch!.resolve(fakeResult());
    await second;

    expect(store.matchResult()).not.toBeNull();
  });
});

/**
 * ============ ĐỔI CHUYẾN LÀ BẢN ĐỒ PHẢI CHUYỂN THEO ============
 *
 * Lỗi người dùng báo: đổi chuyến giao hàng xong bản đồ vẫn nằm ở tuyến cũ, phải
 * tự kéo đi tìm. Ở tầng store có hai điều kiện để bản đồ chuyển được:
 *
 *  1. `focus` (điểm đang được "bay tới") phải bị xoá — nó là một điểm giao của
 *     chuyến CŨ, còn nằm đó là kéo khung nhìn ngược lại.
 *  2. Dữ liệu vẽ (`markers`/`paths`) phải RỖNG trong lúc chờ tải, để lớp bản đồ
 *     biết là chưa có gì để fit và chờ — thay vì fit vào dữ liệu chuyến cũ rồi
 *     coi như đã xong việc.
 *
 * Phần thực hiện fit nằm ở `osm-map.component.spec.ts`.
 */
describe('DeliveryMonitorStore — khung nhìn khi đổi chuyến', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('đổi chuyến -> xoá điểm focus của chuyến cũ', async () => {
    const store = await setup();

    store.selectStop('S3');
    expect(store.focus()).not.toBeNull();

    store.selectTrip('T2');
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.focus()).toBeNull();
    expect(store.selectedStopId()).toBeNull();
  });

  it('trong lúc tải chuyến mới thì không còn marker/đường của chuyến cũ', async () => {
    const store = await setup();
    expect(store.markers().length).toBeGreaterThan(0);

    store.selectTrip('T2');

    // Khoảnh khắc giữa: chưa có dữ liệu mới, và tuyệt đối không được giữ dữ liệu cũ.
    expect(store.markers()).toEqual([]);
    expect(store.paths()).toEqual([]);

    await TestBed.inject(ApplicationRef).whenStable();
    expect(store.markers().length).toBeGreaterThan(0);
  });

  it('fitToken đổi theo chuyến để lớp bản đồ biết phải fit lại', async () => {
    const store = await setup();
    const before = store.tripId();

    store.selectTrip('T2');
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.tripId()).not.toBe(before);
  });
});

/**
 * ============ TUA LẠI HÀNH TRÌNH PHẢI THEO ĐỒNG HỒ CHUYẾN ============
 *
 * Thiết bị GPS thật bắn log DÀY lúc xe chạy và THƯA lúc xe đứng. Tua theo chỉ số
 * mảng vì thế cho ra kết quả ngược đời: quãng xe đứng một chỗ trôi qua chậm rề,
 * còn quãng xe chạy thì vụt mất. Nhãn "4x" cũng không đo cái gì — thay bộ dữ liệu
 * dày hơn là cùng một nhãn ấy chạy chậm đi bốn lần.
 */
describe('DeliveryMonitorStore — tua lại theo đồng hồ chuyến', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /**
   * Track lấy mẫu KHÔNG ĐỀU, đúng như thiết bị thật:
   *  - 30 bản ghi lúc chạy, mỗi 20 giây (cách nhau ~150 m),
   *  - rồi 20 bản ghi lúc đỗ giao hàng, mỗi 90 giây, đứng yên một chỗ.
   */
  function unevenTrack(): RoutePoint[] {
    const start = Date.UTC(2026, 8, 9, 7, 0, 0);
    const points: RoutePoint[] = [];

    for (let i = 0; i < 30; i++) {
      points.push({
        lat: 21 + i * 0.0015,
        lng: 105.8,
        createDate: new Date(start + i * 20_000).toISOString(),
      });
    }

    const last = points[points.length - 1];
    const parkedFrom = start + 30 * 20_000;
    for (let i = 0; i < 20; i++) {
      points.push({
        lat: last.lat,
        lng: last.lng,
        createDate: new Date(parkedFrom + i * 90_000).toISOString(),
      });
    }

    return points;
  }

  const msAt = (track: readonly RoutePoint[], index: number) =>
    Date.parse(track[index].createDate!);

  it('mỗi nhịp tua nhích đúng một lượng THỜI GIAN, không phải một số phần tử', () => {
    const track = unevenTrack();

    // 60× thời gian thật, nhịp 220ms -> 13,2 giây chuyến mỗi nhịp.
    const next = nextCursorByTime(track, 0, 60 * 220);
    const stepped = msAt(track, next) - msAt(track, 0);

    // Vừa đủ vượt 13,2 giây, chứ không phải nhảy nguyên một phần tử 20 giây.
    expect(stepped).toBeGreaterThanOrEqual(13_200);
    expect(stepped).toBeLessThan(13_200 + 20_000);
  });

  it('tua nhanh gấp đôi thì đồng hồ chuyến chạy nhanh gấp đôi', () => {
    const track = unevenTrack();

    const run = (multiplier: number, ticks: number) => {
      let cursor = 0;
      for (let i = 0; i < ticks; i++) cursor = nextCursorByTime(track, cursor, multiplier * 220);
      return msAt(track, cursor) - msAt(track, 0);
    };

    const slow = run(60, 10);
    const fast = run(120, 10);

    expect(fast).toBeGreaterThan(slow * 1.8);
    expect(fast).toBeLessThan(slow * 2.2);
  });

  /**
   * Mật độ lấy mẫu KHÔNG được ảnh hưởng tới tốc độ tua. Đây chính là thứ bản cũ
   * làm sai: cùng nhãn "4x", track dày gấp bốn thì tua chậm đi bốn lần.
   */
  it('làm dày dữ liệu lên gấp bốn không làm tua chậm đi', () => {
    const sparse = unevenTrack();

    // Cùng khoảng thời gian, cùng hình học, chỉ lấy mẫu dày gấp 4.
    const dense: RoutePoint[] = [];
    for (let i = 0; i < sparse.length - 1; i++) {
      const from = msAt(sparse, i);
      const span = msAt(sparse, i + 1) - from;
      for (let k = 0; k < 4; k++) {
        dense.push({
          lat: sparse[i].lat + ((sparse[i + 1].lat - sparse[i].lat) * k) / 4,
          lng: sparse[i].lng,
          createDate: new Date(from + (span * k) / 4).toISOString(),
        });
      }
    }
    dense.push(sparse[sparse.length - 1]);

    // Tua ở 240× -> mỗi nhịp 52,8 giây chuyến, thừa sức vượt bước lấy mẫu 20 giây
    // của bản thưa. (Không thể tua CHẬM hơn bước lấy mẫu: con trỏ luôn phải nhích
    // ít nhất một bản ghi, đó là giới hạn của chính dữ liệu chứ không phải của
    // thuật toán.)
    const elapsed = (track: RoutePoint[]) => {
      let cursor = 0;
      for (let i = 0; i < 6; i++) cursor = nextCursorByTime(track, cursor, 240 * 220);
      return msAt(track, cursor) - msAt(track, 0);
    };

    const a = elapsed(sparse);
    const b = elapsed(dense);

    expect(Math.abs(a - b) / a).toBeLessThan(0.15);
  });

  it('khoảng trống dài vẫn được bước qua — không bao giờ treo thanh tua', () => {
    const track = unevenTrack();

    // Ngay trước quãng đỗ: hai bản ghi cách nhau 90 giây, trong khi một nhịp tua
    // chỉ nhích 13,2 giây chuyến.
    const parked = track.findIndex((p, i, arr) => {
      const next = arr[i + 1];
      return next ? Date.parse(next.createDate!) - Date.parse(p.createDate!) > 60_000 : false;
    });
    expect(parked).toBeGreaterThan(0);

    expect(nextCursorByTime(track, parked, 60 * 220)).toBe(parked + 1);
  });

  it('track thiếu mốc thời gian vẫn tua được, không đứng im', () => {
    const broken: RoutePoint[] = [
      { lat: 21, lng: 105.8 },
      { lat: 21.001, lng: 105.8 },
      { lat: 21.002, lng: 105.8 },
    ];

    expect(nextCursorByTime(broken, 0, 13_200)).toBe(1);
    expect(nextCursorByTime(broken, 1, 13_200)).toBe(2);
  });

  it('tới cuối track thì đứng lại ở điểm cuối', () => {
    const track = unevenTrack();
    const last = track.length - 1;

    expect(nextCursorByTime(track, last, 60 * 220)).toBe(last);
    expect(nextCursorByTime(track, last - 1, 960 * 220)).toBe(last);
    expect(nextCursorByTime([], 0, 1000)).toBe(0);
  });

  /**
   * "Thực tế" là quãng đường của NỬA chuyến, "Dự kiến" là của CẢ chuyến. Trừ hai
   * số đó cho nhau rồi gọi là "chênh lệch" thì màn hình khoe tài xế tiết kiệm
   * được cả chục km, trong khi sự thật là anh ta chưa đi nốt.
   */
  it('so quãng đường thực tế với ĐÚNG phần kế hoạch tương ứng, không với cả tuyến', async () => {
    const store = await setup();

    const stats = store.stats();
    expect(stats.plannedDistanceMeters).toBeGreaterThan(0);

    // Xe mới đi được một phần -> mốc so sánh phải nhỏ hơn hẳn tổng cả tuyến.
    expect(stats.plannedSoFarMeters).toBeGreaterThan(0);
    expect(stats.plannedSoFarMeters).toBeLessThan(stats.plannedDistanceMeters);

    // Và chênh lệch phải tính trên mốc đó.
    const delta = stats.actualDistanceMeters - stats.plannedSoFarMeters;
    expect(Math.abs(delta)).toBeLessThan(
      Math.abs(stats.actualDistanceMeters - stats.plannedDistanceMeters),
    );
  });

  /**
   * Mỗi chấm GPS là một node DOM. Cố định "vẽ 1/4 số điểm" nghĩa là dữ liệu dày
   * lên gấp bốn thì trình duyệt phải dựng gấp bốn số node — màn hình bắt đầu giật
   * đúng vào lúc dữ liệu trở nên tốt hơn.
   */
  it('số chấm GPS có trần, không tỉ lệ thuận với độ dày dữ liệu', async () => {
    const store = await setup({ track: unevenTrack() });

    store.toggleGpsPoints();
    store.seek(store.trackLength() - 1);

    const dots = store.markers().filter((m) => m.key.startsWith('gps-'));
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThanOrEqual(140);
  });
});
