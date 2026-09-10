import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_ROUTING_CONFIG,
  MAP_ROUTING_CONFIG,
  MapRoutingConfig,
} from './map-routing.config';
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

/**
 * ============== CHỐT LỖI NGHIỆP VỤ NẶNG NHẤT CỦA LỚP BẢN ĐỒ ==============
 *
 * Bản cũ chạy `decimatePoints()` lên chính danh sách ĐIỂM GIAO trước khi gửi đi.
 * Với tuyến 35 khách và hạn mức Google 27 điểm, 8 khách bị lấy mẫu rơi mất —
 * nhưng bản đồ vẫn vẽ ra một tuyến liền mạch, đẹp, không có dấu hiệu bất thường
 * nào. Loại lỗi này không thể phát hiện bằng mắt, chỉ test mới chặn được.
 *
 * Nhóm test dưới đây trả lời đúng 3 câu:
 *  1. Số điểm gửi tới provider có đúng bằng số điểm nghiệp vụ không?
 *  2. Vượt hạn mức thì mất điểm hay cắt request?
 *  3. Không có tuyến thì báo lỗi hay bịa ra `0 m / 0 phút`?
 */

/** Điểm giả rải đều theo kinh độ — đủ để đếm và kiểm tra thứ tự. */
function makePoints(n: number): LatLng[] {
  return Array.from({ length: n }, (_, i) => ({ lat: 21, lng: 105.8 + i * 0.01 }));
}

interface Recorded {
  points: readonly LatLng[];
  travelMode?: TravelMode;
}

function makeRoute(points: readonly LatLng[], label: string): RouteResult {
  return {
    path: [...points],
    distanceMeters: (points.length - 1) * 1000,
    durationSeconds: (points.length - 1) * 60,
    legs: points.slice(1).map(() => ({ distanceMeters: 1000, durationSeconds: 60 })),
    source: {
      provider: label.startsWith('Google') ? MapProvider.Google : MapProvider.OpenStreet,
      label,
      travelMode: 'driving',
      profile: label,
    },
  };
}

function setup(options: { provider: MapProvider; config?: Partial<MapRoutingConfig> }) {
  const googleCalls: Recorded[] = [];
  const osrmCalls: Recorded[] = [];

  const google = {
    computeRoutes: vi.fn(
      async (points: readonly LatLng[], opts: { travelMode?: TravelMode } = {}) => {
        googleCalls.push({ points: [...points], travelMode: opts.travelMode });
        return [makeRoute(points, 'Google Routes · Ô tô')];
      },
    ),
  };

  const osrm = {
    computeRoutes: vi.fn(
      async (points: readonly LatLng[], opts: { travelMode?: TravelMode } = {}) => {
        osrmCalls.push({ points: [...points], travelMode: opts.travelMode });
        return [makeRoute(points, 'OSRM Ô tô')];
      },
    ),
  };

  TestBed.configureTestingModule({
    providers: [
      {
        provide: MAP_ROUTING_CONFIG,
        useValue: {
          ...DEFAULT_MAP_ROUTING_CONFIG,
          googleMapsKey: 'test-key',
          ...options.config,
        } satisfies MapRoutingConfig,
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

  TestBed.inject(MapProviderService).setProvider(options.provider);

  return { facade: TestBed.inject(RoutingFacade), google, osrm, googleCalls, osrmCalls };
}

describe('RoutingFacade — waypoint nghiệp vụ không bao giờ bị bỏ', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it.each([2, 3, 25, 27])('giữ nguyên toàn bộ %i điểm và đúng thứ tự (Google)', async (n) => {
    const { facade, googleCalls } = setup({ provider: MapProvider.Google });
    const points = makePoints(n);

    await facade.computeRoute({ points });

    expect(googleCalls.length).toBe(1);
    expect(googleCalls[0].points).toEqual(points);
  });

  it('tuyến 60 điểm qua OSRM vẫn đi trong MỘT request, không mất điểm', async () => {
    const { facade, osrmCalls } = setup({ provider: MapProvider.OpenStreet });
    const points = makePoints(60);

    await facade.computeRoute({ points });

    expect(osrmCalls.length).toBe(1);
    expect(osrmCalls[0].points.length).toBe(60);
  });

  it('vượt hạn mức -> CẮT REQUEST chồng mép, tuyệt đối không lấy mẫu thưa', async () => {
    const { facade, googleCalls } = setup({ provider: MapProvider.Google });
    const points = makePoints(35);

    const route = await facade.computeRoute({ points });

    // 35 điểm, hạn mức 27 -> khúc 1 lấy 27 điểm (0..26), khúc 2 lấy 26..34.
    expect(googleCalls.length).toBe(2);
    expect(googleCalls[0].points.length).toBe(27);
    expect(googleCalls[1].points.length).toBe(9);

    // Điểm nối phải TRÙNG NHAU — đó là thứ giữ cho tuyến liền mạch.
    expect(googleCalls[0].points[26]).toEqual(googleCalls[1].points[0]);

    // Gộp lại phải ra đúng danh sách gốc, đúng thứ tự, không thiếu điểm nào.
    const sent = [...googleCalls[0].points, ...googleCalls[1].points.slice(1)];
    expect(sent).toEqual(points);

    // Số chặng vẫn phải bằng số điểm - 1, nếu không ETA từng điểm giao sẽ lệch.
    expect(route.legs?.length).toBe(points.length - 1);
    expect(route.source?.requestCount).toBe(2);
  });

  it('mọi điểm ĐẦU/CUỐI/TRUNG GIAN đều còn trong request thật', async () => {
    const { facade, googleCalls } = setup({ provider: MapProvider.Google });
    const points = makePoints(40);

    await facade.computeRoute({ points });

    const sent = googleCalls.flatMap((c) => c.points);
    for (const p of points) {
      expect(sent).toContainEqual(p);
    }
  });
});

describe('RoutingFacade — giữ đúng phương tiện và nguồn định tuyến', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it.each<TravelMode>(['driving', 'motorbike', 'cycling', 'walking'])(
    'gửi đúng travelMode "%s" xuống provider',
    async (mode) => {
      const { facade, osrmCalls } = setup({ provider: MapProvider.OpenStreet });

      await facade.computeRoute({ points: makePoints(3), travelMode: mode });

      expect(osrmCalls[0].travelMode).toBe(mode);
    },
  );

  it('giữ nguyên travelMode ở mọi khúc khi phải cắt request', async () => {
    const { facade, osrmCalls } = setup({
      provider: MapProvider.OpenStreet,
      config: { maxWaypointsPerRequest: { google: 27, osrm: 5 } },
    });

    await facade.computeRoute({ points: makePoints(12), travelMode: 'walking' });

    expect(osrmCalls.length).toBeGreaterThan(1);
    expect(osrmCalls.every((c) => c.travelMode === 'walking')).toBe(true);
  });

  it('gắn nhãn nguồn định tuyến vào kết quả', async () => {
    const { facade } = setup({ provider: MapProvider.OpenStreet });

    const route = await facade.computeRoute({ points: makePoints(3) });

    expect(route.source?.label).toBe('OSRM Ô tô');
  });
});

describe('RoutingFacade — dự phòng và lỗi', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  /*
   * ⚠️ TEST NÀY TRƯỚC DÙNG `cycling` — nay phải đổi sang `driving`.
   *
   * Không phải vì test sai, mà vì nghiệp vụ đã đổi: xe đạp và đi bộ giờ ĐI
   * THẲNG sang OSRM ngay từ đầu (`MANDATED_SOURCE`), không bao giờ chạm tới
   * Google nên cũng không bao giờ đi qua nhánh dự phòng này nữa. Muốn kiểm tra
   * nhánh dự phòng thì phải chọn phương tiện mà Google VẪN được gọi.
   * Chính sách ép nguồn có test riêng ở `routing-policy.spec.ts`.
   */
  it('Google không có tuyến -> chuyển sang OSRM và GHI RÕ đã đổi nguồn', async () => {
    const { facade, google, osrmCalls } = setup({ provider: MapProvider.Google });
    google.computeRoutes.mockRejectedValueOnce(
      new RoutingError('NO_ROUTE', 'Google Routes không tìm được lộ trình ô tô.', 'driving'),
    );

    const route = await facade.computeRoute({ points: makePoints(3), travelMode: 'driving' });

    expect(osrmCalls.length).toBe(1);
    expect(osrmCalls[0].travelMode).toBe('driving');
    expect(route.source?.label).toContain('dự phòng cho Google');
    expect(route.source?.note).toContain('không tìm được lộ trình ô tô');
    // Đổi nguồn phải đánh dấu máy đọc được, không chỉ nhét vào chuỗi nhãn.
    expect(route.source?.switched).toBe(true);
  });

  it('cả hai nguồn hỏng -> ném lỗi, KHÔNG trả tuyến chim bay 0 m', async () => {
    const { facade, google, osrm } = setup({ provider: MapProvider.Google });
    google.computeRoutes.mockRejectedValue(new RoutingError('NO_ROUTE', 'Google hỏng'));
    osrm.computeRoutes.mockRejectedValue(new RoutingError('NO_ROUTE', 'OSRM cũng hỏng'));

    // Lỗi cuối phải kể ĐỦ CẢ HAI VẾ, nếu không người dùng chỉ thấy lỗi mạng của
    // nguồn dự phòng và không biết nguyên nhân gốc nằm ở Google.
    await expect(facade.computeRoute({ points: makePoints(3) })).rejects.toThrow(/Google hỏng/);
    await expect(facade.computeRoute({ points: makePoints(3) })).rejects.toThrow(/OSRM cũng hỏng/);
  });

  it('đang dùng OSM thì KHÔNG âm thầm nhảy sang Google (tiêu quota người dùng)', async () => {
    const { facade, osrm, googleCalls } = setup({ provider: MapProvider.OpenStreet });
    osrm.computeRoutes.mockRejectedValueOnce(new RoutingError('PROVIDER_ERROR', 'OSRM chết'));

    await expect(facade.computeRoute({ points: makePoints(3) })).rejects.toThrow('OSRM chết');
    expect(googleCalls.length).toBe(0);
  });

  it('dưới 2 điểm thì trả tuyến rỗng chứ không gọi provider', async () => {
    const { facade, osrmCalls, googleCalls } = setup({ provider: MapProvider.OpenStreet });

    const route = await facade.computeRoute({ points: makePoints(1) });

    expect(route.distanceMeters).toBe(0);
    expect(osrmCalls.length + googleCalls.length).toBe(0);
  });
});
