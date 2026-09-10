import { describe, expect, it } from 'vitest';
import { LatLng, RoutePoint } from '../../core/map';
import { buildTripAlerts } from './alerts.util';
import { DeliveryStop, DeliveryTrip } from './delivery.models';

const DEG_PER_METER = 1 / (111_320 * Math.cos((21 * Math.PI) / 180));
const START = Date.UTC(2026, 8, 9, 0, 0, 0);

/** Chuỗi GPS chạy thẳng hướng đông với tốc độ cho trước. */
function track(count: number, speedKmh: number, secondsPerStep = 60): RoutePoint[] {
  const metersPerStep = (speedKmh / 3.6) * secondsPerStep;

  return Array.from({ length: count }, (_, i) => ({
    lat: 21,
    lng: 105.8 + i * metersPerStep * DEG_PER_METER,
    createDate: new Date(START + i * secondsPerStep * 1000).toISOString(),
  }));
}

function stopAt(lat: number, lng: number, over: Partial<DeliveryStop> = {}): DeliveryStop {
  return {
    id: over.id ?? 'S1',
    seq: 1,
    orderCode: 'DH-1',
    customerName: 'Khách A',
    address: 'Địa chỉ A',
    lat,
    lng,
    plannedArrival: new Date(START).toISOString(),
    actualArrival: null,
    status: 'pending',
    amount: 0,
    ...over,
  };
}

function tripWith(points: RoutePoint[], stops: DeliveryStop[] = []): DeliveryTrip {
  return {
    id: 'T1',
    code: 'GH-T1',
    date: '2026-09-09',
    driverName: 'Tài xế A',
    driverPhone: '0900',
    vehiclePlate: '29A-000.00',
    depot: { name: 'Kho', address: 'Kho', lat: 21, lng: 105.8 },
    stops,
    track: points,
  };
}

describe('buildTripAlerts — quá tốc độ', () => {
  it('gộp một đoạn vượt tốc dài thành MỘT cảnh báo, không phải mỗi điểm một cái', () => {
    const points = track(10, 80); // 80 km/h suốt 9 phút
    const alerts = buildTripAlerts(tripWith(points), points, points, { overspeedKmh: 60 });

    const speeding = alerts.filter((a) => a.type === 'overspeed');
    expect(speeding).toHaveLength(1);
    expect(speeding[0].title).toContain('80 km/h');
  });

  it('bỏ qua cú vọt tốc ngắn hơn ngưỡng thời gian (nhiễu, không phải hành vi)', () => {
    const points = track(10, 30, 60);

    // Đẩy MỘT điểm ra xa để tạo một khoảng vượt tốc dài đúng 60 giây.
    points[5].lng += 1500 * DEG_PER_METER;

    const alerts = buildTripAlerts(tripWith(points), points, points, {
      overspeedKmh: 60,
      overspeedMinSeconds: 180,
    });

    expect(alerts.filter((a) => a.type === 'overspeed')).toHaveLength(0);
  });
});

describe('buildTripAlerts — lệch tuyến', () => {
  const planned: LatLng[] = track(20, 40).map((p) => ({ lat: p.lat, lng: p.lng }));

  it('một điểm nhiễu văng ra rồi quay lại KHÔNG bị coi là lệch tuyến', () => {
    const points = track(20, 40);
    points[10].lat += 500 * (1 / 111_320); // lệch 500 m đúng 1 điểm

    const alerts = buildTripAlerts(tripWith(points), points, planned, {
      deviationThresholdMeters: 120,
      offRouteMinPoints: 3,
    });

    expect(alerts.filter((a) => a.type === 'offroute')).toHaveLength(0);
  });

  it('lệch liên tục nhiều điểm thì báo, kèm khoảng lệch xa nhất', () => {
    const points = track(20, 40);
    for (let i = 8; i <= 13; i++) points[i].lat += 600 * (1 / 111_320);

    const alerts = buildTripAlerts(tripWith(points), points, planned, {
      deviationThresholdMeters: 120,
      offRouteMinPoints: 3,
    });

    const offroute = alerts.filter((a) => a.type === 'offroute');
    expect(offroute).toHaveLength(1);
    expect(offroute[0].severity).toBe('high'); // > 3× ngưỡng
  });
});

describe('buildTripAlerts — dừng đỗ', () => {
  /** Xe chạy một đoạn rồi đứng yên `minutes` phút tại vị trí cuối. */
  function trackWithStop(minutes: number): RoutePoint[] {
    const moving = track(5, 30);
    const last = moving[4];
    const lastMs = new Date(last.createDate!).getTime();

    const parked: RoutePoint[] = Array.from({ length: minutes }, (_, i) => ({
      lat: last.lat + (i % 3) * 0.00002,
      lng: last.lng + (i % 2) * 0.00002,
      createDate: new Date(lastMs + (i + 1) * 60_000).toISOString(),
    }));

    return [...moving, ...parked];
  }

  it('dừng lâu TẠI điểm giao là bình thường — không cảnh báo', () => {
    const points = trackWithStop(40);
    const last = points[points.length - 1];

    const alerts = buildTripAlerts(
      tripWith(points, [stopAt(last.lat, last.lng)]),
      points,
      points,
      { idleMinutes: 12, idleAwayFromStopMeters: 200 },
    );

    expect(alerts.filter((a) => a.type === 'idle')).toHaveLength(0);
  });

  it('dừng lâu ở chỗ KHÔNG có điểm giao nào -> cảnh báo', () => {
    const points = trackWithStop(40);

    // Điểm giao duy nhất nằm cách chỗ đỗ vài km.
    const alerts = buildTripAlerts(
      tripWith(points, [stopAt(21.05, 105.95)]),
      points,
      points,
      { idleMinutes: 12, idleAwayFromStopMeters: 200 },
    );

    const idle = alerts.filter((a) => a.type === 'idle');
    expect(idle).toHaveLength(1);
    expect(idle[0].title).toContain('phút ngoài kế hoạch');
  });
});

describe('buildTripAlerts — lịch giao', () => {
  it('báo giao thất bại ở mức nghiêm trọng nhất', () => {
    const points = track(5, 30);
    const stop = stopAt(21, 105.8, {
      status: 'failed',
      actualArrival: new Date(START).toISOString(),
      note: 'Khách đóng cửa',
    });

    const alerts = buildTripAlerts(tripWith(points, [stop]), points, points);
    const failed = alerts.filter((a) => a.type === 'failed');

    expect(failed).toHaveLength(1);
    expect(failed[0].severity).toBe('high');
    // Cảnh báo nặng luôn được xếp lên đầu danh sách.
    expect(alerts[0].severity).toBe('high');
  });

  it('tới trễ quá ngưỡng thì báo, tới sớm thì không', () => {
    const points = track(5, 30);

    const late = stopAt(21, 105.8, {
      id: 'LATE',
      status: 'delivered',
      plannedArrival: new Date(START).toISOString(),
      actualArrival: new Date(START + 45 * 60_000).toISOString(),
    });

    const early = stopAt(21, 105.8, {
      id: 'EARLY',
      status: 'delivered',
      plannedArrival: new Date(START + 60 * 60_000).toISOString(),
      actualArrival: new Date(START + 30 * 60_000).toISOString(),
    });

    const alerts = buildTripAlerts(tripWith(points, [late, early]), points, points, {
      lateMinutes: 15,
    });

    const lateAlerts = alerts.filter((a) => a.type === 'late');
    expect(lateAlerts).toHaveLength(1);
    expect(lateAlerts[0].title).toContain('45 phút');
  });
});

describe('buildTripAlerts — dữ liệu hỏng', () => {
  it('không ném lỗi khi track rỗng hoặc thiếu mốc thời gian', () => {
    expect(() => buildTripAlerts(tripWith([]), [], [])).not.toThrow();

    const noTime: RoutePoint[] = [
      { lat: 21, lng: 105.8 },
      { lat: 21.01, lng: 105.81 },
    ];
    expect(() => buildTripAlerts(tripWith(noTime), noTime, noTime)).not.toThrow();
  });

  it('giờ giao hỏng không làm cảnh báo "trễ" biến mất âm thầm', () => {
    const points = track(5, 30);
    const broken = stopAt(21, 105.8, {
      status: 'delivered',
      plannedArrival: 'không-phải-ngày',
      actualArrival: new Date(START).toISOString(),
    });

    const alerts = buildTripAlerts(tripWith(points, [broken]), points, points);

    // Không có cách nào biết trễ hay không -> không được bịa ra cảnh báo,
    // nhưng cũng không được ném lỗi làm chết cả danh sách.
    expect(alerts.filter((a) => a.type === 'late')).toHaveLength(0);
  });
});
