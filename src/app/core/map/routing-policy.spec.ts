import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAP_ROUTING_CONFIG, MAP_ROUTING_CONFIG } from './map-routing.config';
import { LatLng, MapProvider, RouteResult, TravelMode } from './map.types';
import { MapProviderService } from './map-provider.service';
import { RoutingFacade } from './routing.facade';
import { RoutingError } from './routing.error';
import { GoogleRoutesService } from './google/google-routes.service';
import { GoogleMatrixService } from './google/google-matrix.service';
import { OsrmRoutingService } from './osm/osrm-routing.service';
import { OsrmMatrixService } from './osm/osrm-matrix.service';
import { OsrmNearestService } from './osm/osrm-nearest.service';
import { OsrmMatchService } from './osm/osrm-match.service';
import {
  IMPLAUSIBLE_DETOUR_RATIO,
  MIN_DISTANCE_FOR_DETOUR_CHECK_METERS,
  crowFlyMeters,
  judgeDetour,
} from './routing-capability';

/**
 * ================== LỖI IM LẶNG: TUYẾN ĐI BỘ 21,7 KM ==================
 *
 * Nhóm test này tái dựng đúng một sự cố THẬT, bằng đúng số liệu đã đo được từ
 * API thật ngày 10/09 (chi tiết trong `routing-capability.ts`):
 *
 *   Ngọc Lâm (21.0447, 105.8752) -> Bà Triệu (21.0126, 105.8489)
 *   đường chim bay 4.493 m
 *   Google WALK        : 21.741 m — vòng 9 km xuống ĐT378 rồi QUA PHÀ Kim Lan
 *   OSRM routed-foot   :  6.573 m — qua CẦU LONG BIÊN (1.850 m)
 *
 * Vì sao lọt lưới toàn bộ test cũ: Google trả **HTTP 200 kèm tuyến hợp lệ**.
 * Không có exception, không có `routes: []`, polyline vẽ ra một đường liền mạch
 * rất thuyết phục. Mọi lớp bắt lỗi đều đúng chức năng và đều im lặng — cơ chế
 * dự phòng chỉ kích hoạt khi provider NÉM LỖI, mà ở đây nó không ném.
 *
 * Bài học đóng đinh bằng test: với dữ liệu bản đồ, "không có lỗi" KHÔNG đồng
 * nghĩa với "số liệu đúng". Phải có chốt chặn dựa trên tính hợp lý của kết quả,
 * không chỉ dựa trên trạng thái HTTP.
 */

const NGOC_LAM: LatLng = { lat: 21.0447, lng: 105.8752 };
const BA_TRIEU: LatLng = { lat: 21.0126, lng: 105.8489 };
const HANOI_LEG = [NGOC_LAM, BA_TRIEU];

/** Số đo thật, không phải số bịa — xem bảng trong `routing-capability.ts`. */
const MEASURED = {
  crowFly: 4493,
  googleWalkFerry: 21741,
  osrmWalkLongBienBridge: 6573,
  osrmBikeLongBienBridge: 6748,
  googleDriveTrafficUnaware: 6792,
  googleDriveTrafficAware: 10787,
};

function route(distanceMeters: number, provider: MapProvider, label: string): RouteResult {
  return {
    path: [...HANOI_LEG],
    distanceMeters,
    durationSeconds: distanceMeters,
    legs: [{ distanceMeters, durationSeconds: distanceMeters }],
    source: { provider, label, travelMode: 'walking', profile: label },
  };
}

interface Call {
  points: readonly LatLng[];
  travelMode?: TravelMode;
  routingPreference?: string;
}

function setup(opts: {
  provider?: MapProvider;
  googleDistance?: number | 'throw';
  osrmDistance?: number | 'throw';
}) {
  const googleCalls: Call[] = [];
  const osrmCalls: Call[] = [];

  const google = {
    computeRoutes: vi.fn(async (points: readonly LatLng[], o: any = {}) => {
      googleCalls.push({
        points: [...points],
        travelMode: o.travelMode,
        routingPreference: o.routingPreference,
      });
      if (opts.googleDistance === 'throw') {
        throw new RoutingError('NO_ROUTE', 'Google hỏng.', o.travelMode, 'Google Routes');
      }
      return [route(opts.googleDistance ?? 5000, MapProvider.Google, 'Google Routes · Đi bộ')];
    }),
  };

  const osrm = {
    computeRoutes: vi.fn(async (points: readonly LatLng[], o: any = {}) => {
      osrmCalls.push({ points: [...points], travelMode: o.travelMode });
      if (opts.osrmDistance === 'throw') {
        throw new RoutingError('NO_ROUTE', 'OSRM hỏng.', o.travelMode, 'OSRM');
      }
      return [route(opts.osrmDistance ?? 5000, MapProvider.OpenStreet, 'OSRM Đi bộ')];
    }),
  };

  TestBed.configureTestingModule({
    providers: [
      {
        provide: MAP_ROUTING_CONFIG,
        useValue: { ...DEFAULT_MAP_ROUTING_CONFIG, googleMapsKey: 'test-key' },
      },
      { provide: GoogleRoutesService, useValue: google },
      { provide: OsrmRoutingService, useValue: osrm },
      { provide: GoogleMatrixService, useValue: {} },
      { provide: OsrmMatrixService, useValue: {} },
      { provide: OsrmNearestService, useValue: {} },
      { provide: OsrmMatchService, useValue: {} },
      MapProviderService,
      RoutingFacade,
    ],
  });

  TestBed.inject(MapProviderService).setProvider(opts.provider ?? MapProvider.Google);
  return { facade: TestBed.inject(RoutingFacade), googleCalls, osrmCalls };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  localStorage.clear();
});

describe('Đường chim bay — chặn dưới tuyệt đối của mọi lộ trình', () => {
  it('khớp khoảng cách thật giữa Ngọc Lâm và Bà Triệu (~4.493 m)', () => {
    // Sai số cho phép 20 m: đủ chặt để bắt lỗi đảo lat/lng (sẽ lệch hàng nghìn km).
    expect(crowFlyMeters(HANOI_LEG)).toBeCloseTo(MEASURED.crowFly, -1.2);
  });

  it('cộng dồn theo ĐÚNG THỨ TỰ điểm dừng, không phải khoảng cách đầu-cuối', () => {
    // Đi vòng qua điểm thứ 3 rồi quay lại phải dài hơn đi thẳng.
    const detour = crowFlyMeters([NGOC_LAM, { lat: 21.2, lng: 105.9 }, BA_TRIEU]);
    expect(detour).toBeGreaterThan(crowFlyMeters(HANOI_LEG) * 2);
  });
});

describe('judgeDetour — nhận diện tuyến vòng phi lý bằng số đo thật', () => {
  it('CHẤP NHẬN tuyến đi bộ qua cầu Long Biên (6.573 m ≈ 1,5 lần chim bay)', () => {
    const verdict = judgeDetour(
      route(MEASURED.osrmWalkLongBienBridge, MapProvider.OpenStreet, 'OSRM'),
      HANOI_LEG,
    );
    expect(verdict.ratio).toBeLessThan(2);
    expect(verdict.implausible).toBe(false);
  });

  it('CHẤP NHẬN tuyến ô tô vòng tránh tắc (10.787 m ≈ 2,4 lần) — vòng nhưng có thật', () => {
    const verdict = judgeDetour(
      route(MEASURED.googleDriveTrafficAware, MapProvider.Google, 'Google'),
      HANOI_LEG,
    );
    expect(verdict.ratio).toBeGreaterThan(2);
    expect(verdict.implausible).toBe(false);
  });

  it('BẮT được tuyến đi bộ qua phà của Google (21.741 m ≈ 4,8 lần)', () => {
    const verdict = judgeDetour(
      route(MEASURED.googleWalkFerry, MapProvider.Google, 'Google'),
      HANOI_LEG,
    );
    expect(verdict.ratio).toBeGreaterThan(IMPLAUSIBLE_DETOUR_RATIO);
    expect(verdict.implausible).toBe(true);
  });

  it('BỎ QUA tuyến ngắn: trong phố cổ hệ số vòng cao là bình thường', () => {
    // Hai điểm cách nhau ~110 m, đi vòng đường một chiều thành 600 m = 5,4 lần.
    // Đúng ngưỡng "phi lý" nhưng hoàn toàn có thật -> không được báo động.
    const near = [
      { lat: 21.03, lng: 105.85 },
      { lat: 21.031, lng: 105.85 },
    ];
    expect(crowFlyMeters(near)).toBeLessThan(MIN_DISTANCE_FOR_DETOUR_CHECK_METERS);
    expect(judgeDetour(route(600, MapProvider.Google, 'Google'), near).implausible).toBe(false);
  });

  /*
   * Test này CỐ TÌNH khẳng định một điểm YẾU, không phải một điểm mạnh.
   * Nó khoá lại sự thật: trên tuyến 3 điểm, chính tuyến đi phà sai bét của
   * Google vẫn lọt ngưỡng (2,90 < 3,0) vì phần vòng sai bị pha loãng.
   * Ai định gỡ `MANDATED_SOURCE` với lý do "đã có chốt chặn hệ số vòng rồi"
   * sẽ vấp phải test này.
   */
  it('THỪA NHẬN ĐIỂM YẾU: tuyến 3 điểm che được sai số — 30.033/10.352 = 2,9 vẫn lọt', () => {
    const threePoints = [NGOC_LAM, BA_TRIEU, { lat: 21.0333, lng: 105.797 }];
    const verdict = judgeDetour(route(30033, MapProvider.Google, 'Google'), threePoints);

    expect(verdict.crowFlyMeters).toBeCloseTo(10352, -2);
    expect(verdict.ratio).toBeLessThan(IMPLAUSIBLE_DETOUR_RATIO);
    expect(verdict.implausible).toBe(false);
  });

  it('điểm trùng nhau -> ratio Infinity nhưng KHÔNG báo động (chia cho 0)', () => {
    const same = [NGOC_LAM, { ...NGOC_LAM }];
    const verdict = judgeDetour(route(0, MapProvider.Google, 'Google'), same);
    expect(verdict.ratio).toBe(Infinity);
    expect(verdict.implausible).toBe(false);
  });
});

describe('Ép nguồn theo phương tiện — không chờ Google hỏng mới đổi', () => {
  it('ĐI BỘ: đang chọn bản đồ Google vẫn gọi thẳng OSRM, KHÔNG gọi Google', async () => {
    const { facade, googleCalls, osrmCalls } = setup({
      googleDistance: MEASURED.googleWalkFerry,
      osrmDistance: MEASURED.osrmWalkLongBienBridge,
    });

    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'walking' });

    expect(googleCalls).toHaveLength(0);
    expect(osrmCalls).toHaveLength(1);
    expect(result.distanceMeters).toBe(MEASURED.osrmWalkLongBienBridge);
  });

  it('XE ĐẠP: cũng đi thẳng OSRM (Google trả routes rỗng ở VN)', async () => {
    const { facade, googleCalls, osrmCalls } = setup({
      googleDistance: 'throw',
      osrmDistance: MEASURED.osrmBikeLongBienBridge,
    });

    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'cycling' });

    expect(googleCalls).toHaveLength(0);
    expect(osrmCalls[0].travelMode).toBe('cycling');
    expect(result.distanceMeters).toBe(MEASURED.osrmBikeLongBienBridge);
  });

  it('đánh dấu `switched` + nêu LÝ DO, không đổi nguồn lén', async () => {
    const { facade } = setup({ osrmDistance: MEASURED.osrmWalkLongBienBridge });
    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'walking' });

    expect(result.source?.switched).toBe(true);
    expect(result.source?.note).toMatch(/sông Hồng|phà/i);
  });

  it('Ô TÔ và XE MÁY vẫn dùng Google — không ép nhầm cả những mode Google làm tốt', async () => {
    for (const mode of ['driving', 'motorbike'] as TravelMode[]) {
      TestBed.resetTestingModule();
      const { facade, googleCalls, osrmCalls } = setup({
        googleDistance: MEASURED.googleDriveTrafficUnaware,
      });
      await facade.computeRoute({ points: HANOI_LEG, travelMode: mode });
      expect(googleCalls, mode).toHaveLength(1);
      expect(osrmCalls, mode).toHaveLength(0);
    }
  });

  it('đang chọn bản đồ OSM thì không phát sinh lần gọi Google nào', async () => {
    const { facade, googleCalls } = setup({
      provider: MapProvider.OpenStreet,
      osrmDistance: MEASURED.osrmWalkLongBienBridge,
    });
    await facade.computeRoute({ points: HANOI_LEG, travelMode: 'walking' });
    expect(googleCalls).toHaveLength(0);
  });
});

describe('Đối chiếu khi tuyến vòng phi lý — lưới an toàn cho khoảng trống CHƯA biết', () => {
  it('Google ra tuyến vòng 4,8 lần -> gọi OSRM đối chiếu và giữ tuyến ngắn hơn', async () => {
    // Dùng phương tiện KHÔNG bị ép nguồn để chắc chắn đang thử đúng tầng 3.
    const { facade, googleCalls, osrmCalls } = setup({
      googleDistance: MEASURED.googleWalkFerry,
      osrmDistance: MEASURED.googleDriveTrafficUnaware,
    });

    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving' });

    expect(googleCalls).toHaveLength(1);
    expect(osrmCalls).toHaveLength(1);
    expect(result.distanceMeters).toBe(MEASURED.googleDriveTrafficUnaware);
    expect(result.source?.switched).toBe(true);
    expect(result.source?.note).toMatch(/chim bay/);
  });

  it('nguồn đối chiếu DÀI HƠN -> giữ tuyến gốc, chỉ cảnh báo (không đổi bừa)', async () => {
    const { facade } = setup({
      googleDistance: MEASURED.googleWalkFerry,
      osrmDistance: MEASURED.googleWalkFerry + 5000,
    });

    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving' });

    expect(result.distanceMeters).toBe(MEASURED.googleWalkFerry);
    expect(result.source?.provider).toBe(MapProvider.Google);
    expect(result.source?.note).toMatch(/chim bay/);
  });

  it('nguồn đối chiếu HỎNG -> vẫn trả tuyến gốc kèm cảnh báo, không ném lỗi', async () => {
    const { facade } = setup({
      googleDistance: MEASURED.googleWalkFerry,
      osrmDistance: 'throw',
    });

    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving' });

    expect(result.distanceMeters).toBe(MEASURED.googleWalkFerry);
    expect(result.source?.note).toMatch(/chim bay/);
  });

  it('tuyến hợp lý -> KHÔNG gọi nguồn thứ hai (không nhân đôi độ trễ và hoá đơn)', async () => {
    const { facade, osrmCalls } = setup({ googleDistance: MEASURED.googleDriveTrafficUnaware });
    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving' });

    expect(osrmCalls).toHaveLength(0);
    expect(result.source?.switched).toBeUndefined();
  });

  it('luôn ghi lại hệ số vòng để UI hiện ra — con số đã thiếu khi sự cố xảy ra', async () => {
    const { facade } = setup({ googleDistance: MEASURED.googleDriveTrafficUnaware });
    const result = await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving' });

    expect(result.source?.detourRatio).toBeGreaterThan(1.4);
    expect(result.source?.detourRatio).toBeLessThan(1.6);
  });
});

describe('Công tắc tính-theo-giao-thông', () => {
  it('mặc định TẮT: gửi TRAFFIC_UNAWARE để quãng đường ổn định giữa các lần gọi', async () => {
    const { facade, googleCalls } = setup({ googleDistance: MEASURED.googleDriveTrafficUnaware });
    await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving' });
    expect(googleCalls[0].routingPreference).toBe('TRAFFIC_UNAWARE');
  });

  it('bật lên thì gửi TRAFFIC_AWARE — dành cho màn dẫn đường', async () => {
    const { facade, googleCalls } = setup({ googleDistance: MEASURED.googleDriveTrafficAware });
    await facade.computeRoute({ points: HANOI_LEG, travelMode: 'driving', trafficAware: true });
    expect(googleCalls[0].routingPreference).toBe('TRAFFIC_AWARE');
  });
});
