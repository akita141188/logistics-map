import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapProvider } from '../../core/map/map.types';
import type { LatLng, RouteResult } from '../../core/map/map.types';
import {
  destinationPoint,
  distanceMeters,
  distanceToPathMeters,
  totalDistanceMeters,
} from '../../core/map/geo.util';
import { cumulativeAlong } from '../../core/map/navigation.util';
import { MapProviderService } from '../../core/map/map-provider.service';
import { DEFAULT_MAP_ROUTING_CONFIG, MAP_ROUTING_CONFIG } from '../../core/map/map-routing.config';
import { RoutingFacade } from '../../core/map/routing.facade';
import { DeliveryMockApi } from './delivery-mock.api';

/**
 * ============ DỮ LIỆU GIẢ LẬP CŨNG PHẢI ĐÚNG NGHIỆP VỤ ============
 *
 * Màn Giám sát lộ trình không trình bày GPS log, nó trình bày KẾT LUẬN rút ra từ
 * GPS log. Một bộ dữ liệu giả lập mâu thuẫn nội tại sẽ đẻ ra những kết luận sai
 * mà trông vẫn rất thuyết phục — nguy hiểm hơn hẳn một màn hình lỗi hẳn.
 *
 * Ba ràng buộc được khoá ở đây:
 *  1. Xe không bao giờ chạy vượt qua một khách hàng đang mang trạng thái "Chưa tới".
 *  2. Đường xe chạy luôn NẰM TRÊN đường đã định tuyến (trừ đoạn cố ý đi lệch).
 *  3. Không bao giờ bịa hình học: định tuyến hỏng thì bỏ đoạn đi lệch, không nối thẳng.
 */

/**
 * Định tuyến giả lập BÁM PHỐ: mỗi chặng đi theo hình chữ L (đi ngang trước, đi
 * dọc sau) thay vì đường chim bay.
 *
 * Vì sao không dùng đường thẳng: cả lớp lỗi cần bắt ở đây là "đường xe chạy cắt
 * ngang qua chỗ không có đường". Nếu tuyến tham chiếu vốn đã là đường thẳng thì
 * mọi cách cắt góc đều trùng khít với nó và test không bao giờ đỏ.
 */
function lShapedRoute(points: readonly LatLng[]): RouteResult {
  const path: LatLng[] = [points[0]];
  const legs: { distanceMeters: number; durationSeconds: number }[] = [];

  for (let i = 1; i < points.length; i++) {
    const from = path[path.length - 1];
    const to = points[i];
    const corner: LatLng = { lat: from.lat, lng: to.lng };

    const before = totalDistanceMeters(path);

    // 12 đỉnh mỗi cạnh -> polyline dày, đủ để lộ ra kiểu lấy mẫu theo chỉ số.
    for (let k = 1; k <= 12; k++) {
      path.push({ lat: from.lat, lng: from.lng + ((corner.lng - from.lng) * k) / 12 });
    }
    for (let k = 1; k <= 12; k++) {
      path.push({ lat: corner.lat + ((to.lat - corner.lat) * k) / 12, lng: to.lng });
    }

    const meters = totalDistanceMeters(path) - before;
    // ~22 km/h.
    legs.push({ distanceMeters: meters, durationSeconds: (meters / 1000 / 22) * 3600 });
  }

  return {
    path,
    distanceMeters: totalDistanceMeters(path),
    durationSeconds: legs.reduce((s, l) => s + l.durationSeconds, 0),
    legs,
  };
}

const computeRoute = vi.fn(async ({ points }: { points: readonly LatLng[] }) =>
  lShapedRoute(points),
);

function setup(provider = MapProvider.OpenStreet) {
  computeRoute.mockClear();

  TestBed.configureTestingModule({
    providers: [
      { provide: RoutingFacade, useValue: { computeRoute } },
      { provide: MAP_ROUTING_CONFIG, useValue: DEFAULT_MAP_ROUTING_CONFIG },
    ],
  });

  TestBed.inject(MapProviderService).setProvider(provider);
  return TestBed.inject(DeliveryMockApi);
}

describe('DeliveryMockApi — hình học', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    computeRoute.mockImplementation(async ({ points }: { points: readonly LatLng[] }) =>
      lShapedRoute(points),
    );
  });

  it('mọi điểm GPS đều nằm trên lộ trình đã định tuyến hoặc trên đoạn đi lệch', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HCM-01'); // chuyến KHÔNG có đoạn đi lệch
    const planned = await api.getPlannedPath('TRIP-HCM-01');

    const worst = Math.max(
      ...trip.track.map((p) => distanceToPathMeters({ lat: p.lat, lng: p.lng }, planned)),
    );

    // Chỉ còn đúng sai số GPS mô phỏng (7 m). Bản cũ lấy mẫu theo chỉ số mảng
    // nên lệch tới hàng trăm mét ở mỗi khúc cua.
    expect(worst).toBeLessThan(8);
  });

  it('không có dây cung dài bất thường giữa hai điểm GPS liên tiếp', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HCM-01');

    let maxGap = 0;
    for (let i = 1; i < trip.track.length; i++) {
      maxGap = Math.max(maxGap, distanceMeters(trip.track[i - 1], trip.track[i]));
    }

    // Đúng bằng bước lấy mẫu 40 m (+ chút nhiễu ngang).
    expect(maxGap).toBeLessThan(60);
  });

  it('đoạn đi lệch tuyến là đường ĐÃ ĐỊNH TUYẾN, không phải nối thẳng', async () => {
    const api = setup();
    await api.getTrip('TRIP-HN-01');

    // 1 request cho lộ trình chính + 1 request riêng cho vòng đi lệch.
    expect(computeRoute).toHaveBeenCalledTimes(2);
    expect(computeRoute.mock.calls[1][0].points).toHaveLength(3);
  });

  it('định tuyến đoạn đi lệch hỏng -> BỎ đoạn đó, tuyệt đối không bịa đường thẳng', async () => {
    const api = setup();

    let call = 0;
    computeRoute.mockImplementation(async ({ points }: { points: readonly LatLng[] }) => {
      // Lần gọi thứ 2 là vòng đi lệch.
      if (++call === 2) throw new Error('mất mạng');
      return lShapedRoute(points);
    });

    const trip = await api.getTrip('TRIP-HN-01');
    const planned = await api.getPlannedPath('TRIP-HN-01');

    const worst = Math.max(
      ...trip.track.map((p) => distanceToPathMeters({ lat: p.lat, lng: p.lng }, planned)),
    );
    expect(worst).toBeLessThan(8);
  });
});

describe('DeliveryMockApi — nhất quán với trạng thái đơn hàng', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    computeRoute.mockImplementation(async ({ points }: { points: readonly LatLng[] }) =>
      lShapedRoute(points),
    );
  });

  /**
   * LỖI ĐÃ TỪNG CÓ THẬT: track bị cắt ở "72% số ĐỈNH" — một tỉ lệ không mang ý
   * nghĩa nghiệp vụ nào. Trên tuyến Hà Nội, 72% số đỉnh rơi vào 75,7% quãng đường,
   * trong khi khách hàng số 6 nằm ở 61,6% và số 7 ở 68,7%. Kết quả: xe đã chạy
   * vượt qua hai khách hàng đang hiện "Chưa tới", vượt 3–5 km.
   */
  it('xe KHÔNG chạy vượt qua khách hàng còn đang "Chưa tới"', async () => {
    const api = setup();

    for (const id of ['TRIP-HN-01', 'TRIP-HCM-01', 'TRIP-DN-01']) {
      const trip = await api.getTrip(id);
      const last = trip.track[trip.track.length - 1];

      for (const stop of trip.stops) {
        if (stop.status !== 'pending') continue;

        // Không điểm GPS nào được lại gần một điểm chưa giao hơn 300 m.
        const closest = Math.min(
          ...trip.track.map((p) => distanceMeters({ lat: p.lat, lng: p.lng }, stop)),
        );
        expect(closest, `${id} / ${stop.customerName}`).toBeGreaterThan(300);
      }

      expect(last).toBeDefined();
    }
  });

  it('điểm đã xử lý thì xe phải từng đi qua', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HN-01');

    for (const stop of trip.stops) {
      if (stop.status === 'pending') continue;

      const closest = Math.min(
        ...trip.track.map((p) => distanceMeters({ lat: p.lat, lng: p.lng }, stop)),
      );
      expect(closest, stop.customerName).toBeLessThan(60);
    }
  });

  it('giờ tới thực tế tăng dần và tốc độ suy ra luôn khả thi', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HN-01');

    const handled = trip.stops.filter((s) => s.actualArrival);
    expect(handled.length).toBeGreaterThan(2);

    for (let i = 1; i < handled.length; i++) {
      const prev = new Date(handled[i - 1].actualArrival!).getTime();
      const cur = new Date(handled[i].actualArrival!).getTime();
      expect(cur).toBeGreaterThan(prev);

      const meters = distanceMeters(handled[i - 1], handled[i]);
      const kmh = meters / 1000 / ((cur - prev) / 3_600_000);

      // Bộ seed cũ (gõ tay số phút chậm) cho ra đoạn 129 km/h giữa nội thành.
      expect(kmh, `${handled[i - 1].customerName} -> ${handled[i].customerName}`).toBeLessThan(60);
    }
  });

  it('điểm chưa giao thì không có giờ tới thực tế', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HN-01');

    for (const stop of trip.stops) {
      if (stop.status === 'pending') expect(stop.actualArrival).toBeNull();
      else expect(stop.actualArrival).toBeTruthy();
    }
  });
});

describe('DeliveryMockApi — cache', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    computeRoute.mockImplementation(async ({ points }: { points: readonly LatLng[] }) =>
      lShapedRoute(points),
    );
  });

  it('gọi lại cùng chuyến, cùng provider thì không định tuyến lại', async () => {
    const api = setup();

    await api.getTrip('TRIP-HCM-01');
    const after = computeRoute.mock.calls.length;
    await api.getTrip('TRIP-HCM-01');

    expect(computeRoute.mock.calls.length).toBe(after);
  });

  /**
   * Khoá cache chỉ theo `tripId` thì sau khi đổi nhà cung cấp bản đồ, đường nét
   * đứt (lộ trình dự kiến) là hình học của nguồn MỚI còn đường xe chạy vẫn là
   * hình học của nguồn CŨ. Hai đường lệch nhau cả trăm mét, không lời giải thích.
   */
  it('đổi nhà cung cấp bản đồ thì sinh lại track theo hình học của nguồn mới', async () => {
    const api = setup(MapProvider.OpenStreet);
    await api.getTrip('TRIP-HCM-01');
    const after = computeRoute.mock.calls.length;

    TestBed.inject(MapProviderService).setProvider(MapProvider.Google);
    await api.getTrip('TRIP-HCM-01');

    expect(computeRoute.mock.calls.length).toBeGreaterThan(after);
  });
});

describe('DeliveryMockApi — mô phỏng vật lý', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    computeRoute.mockImplementation(async ({ points }: { points: readonly LatLng[] }) =>
      lShapedRoute(points),
    );
  });

  it('tốc độ có biến thiên, không phải một con số phẳng lì', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HCM-01');

    const moving = trip.track.map((p) => p.speedKmh ?? 0).filter((v) => v > 0);
    const min = Math.min(...moving);
    const max = Math.max(...moving);

    // Bản cũ rải thời gian đều theo quãng đường -> MỌI điểm đều ~8 km/h, nên
    // ngưỡng cảnh báo quá tốc độ (60 km/h) là thứ không bao giờ chạm tới được.
    expect(max).toBeGreaterThan(min * 2);
  });

  it('có quãng xe đỗ giao hàng: toạ độ đứng yên trong khi đồng hồ vẫn chạy', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HCM-01');

    let longestStillSeconds = 0;
    for (let i = 1; i < trip.track.length; i++) {
      const meters = distanceMeters(trip.track[i - 1], trip.track[i]);
      if (meters > 15) continue;

      const seconds =
        (new Date(trip.track[i].createDate!).getTime() -
          new Date(trip.track[i - 1].createDate!).getTime()) /
        1000;
      longestStillSeconds = Math.max(longestStillSeconds, seconds);
    }

    expect(longestStillSeconds).toBeGreaterThan(60);
  });

  it('pin tụt dần theo thời gian và không bao giờ âm', async () => {
    const api = setup();
    const trip = await api.getTrip('TRIP-HCM-01');

    const first = trip.track[0].battery ?? 0;
    const last = trip.track[trip.track.length - 1].battery ?? 0;

    expect(first).toBeGreaterThan(last);
    expect(last).toBeGreaterThan(0);
  });
});

/** Kiểm tra phụ: bộ dựng tuyến giả lập đúng là hình chữ L, không phải đường thẳng. */
describe('lShapedRoute (đồ nghề của chính bộ test)', () => {
  it('bẻ góc thật, nên cắt góc là bị phát hiện', () => {
    const a = { lat: 21, lng: 105.8 };
    const b = destinationPoint(destinationPoint(a, 90, 1000), 0, 1000);
    const route = lShapedRoute([a, b]);

    const cum = cumulativeAlong(route.path);
    expect(cum[cum.length - 1]).toBeGreaterThan(distanceMeters(a, b) * 1.3);
  });
});
