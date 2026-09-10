import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OFF_ROUTE_OPTIONS,
  INITIAL_OFF_ROUTE_STATE,
  activeLegIndex,
  bearingAtAlong,
  cumulativeAlong,
  etaSeconds,
  guidanceAt,
  legBoundaries,
  maneuverIcon,
  pointAtAlong,
  projectOnPath,
  stepOffsets,
  updateOffRoute,
} from './navigation.util';
import { destinationPoint, distanceMeters } from './geo.util';
import { LatLng, RouteStep } from './map.types';

/** Một tuyến chữ L: 1 km về phía đông rồi 1 km lên phía bắc. */
function lRoute(): LatLng[] {
  const start: LatLng = { lat: 21, lng: 105.8 };
  const corner = destinationPoint(start, 90, 1000);
  const end = destinationPoint(corner, 0, 1000);
  return [start, corner, end];
}

function step(instruction: string, meters: number, modifier?: string): RouteStep {
  return {
    instruction,
    roadName: instruction,
    distanceMeters: meters,
    durationSeconds: meters / 10,
    location: { lat: 21, lng: 105.8 },
    maneuver: 'turn',
    modifier,
  };
}

describe('projectOnPath — chiếu vị trí GPS xuống tuyến', () => {
  it('điểm nằm ngay trên tuyến thì độ lệch ~0 và quãng đường dọc tuyến đúng', () => {
    const path = lRoute();
    const onRoute = destinationPoint(path[0], 90, 400);

    const p = projectOnPath(onRoute, path);

    expect(p.lateralMeters).toBeLessThan(1);
    expect(p.alongMeters).toBeCloseTo(400, 0);
    expect(p.index).toBe(0);
  });

  it('điểm lệch sang bên thì trả đúng khoảng cách vuông góc và điểm bám đường', () => {
    const path = lRoute();
    const onRoute = destinationPoint(path[0], 90, 400);
    // Đẩy lệch 80 m về phía bắc (vuông góc với đoạn đang chạy hướng đông).
    const drifted = destinationPoint(onRoute, 0, 80);

    const p = projectOnPath(drifted, path);

    expect(p.lateralMeters).toBeCloseTo(80, 0);
    // Hình chiếu phải rơi lại đúng chỗ cũ trên tuyến, không bị kéo dọc theo đường.
    expect(distanceMeters(p.snapped, onRoute)).toBeLessThan(2);
    expect(p.alongMeters).toBeCloseTo(400, -1);
  });

  it('quét từ chỉ số hiện tại để không nhảy sang nhánh tuyến đi qua lần hai', () => {
    // Tuyến đi ra rồi quay lại đúng con đường cũ: đông 1 km rồi tây 1 km.
    const start: LatLng = { lat: 21, lng: 105.8 };
    const far = destinationPoint(start, 90, 1000);
    const path = [start, far, start];

    // Xe đang trên đường VỀ, ở mốc 1.400 m (tức cách điểm đầu 600 m).
    const here = pointAtAlong(path, 1400);

    const naive = projectOnPath(here, path);
    const guided = projectOnPath(here, path, undefined, 1);

    // Chiếu toàn cục bị hút về nhánh ĐI (600 m) — sai 800 m.
    expect(naive.alongMeters).toBeCloseTo(600, -1);
    // Quét từ đoạn đang chạy thì ra đúng mốc thật.
    expect(guided.alongMeters).toBeCloseTo(1400, -1);
  });
});

describe('pointAtAlong / bearingAtAlong', () => {
  it('trả đúng vị trí theo quãng đường, không theo chỉ số đỉnh', () => {
    const path = lRoute();
    const cum = cumulativeAlong(path);

    expect(cum[cum.length - 1]).toBeCloseTo(2000, -1);
    expect(distanceMeters(pointAtAlong(path, 0, cum), path[0])).toBeLessThan(1);
    expect(distanceMeters(pointAtAlong(path, 1000, cum), path[1])).toBeLessThan(1);
    expect(distanceMeters(pointAtAlong(path, 5000, cum), path[2])).toBeLessThan(1);
  });

  it('hướng mũi xe đổi từ đông sang bắc khi qua khúc cua', () => {
    const path = lRoute();
    expect(bearingAtAlong(path, 500)).toBeCloseTo(90, 0);
    expect(bearingAtAlong(path, 1500)).toBeCloseTo(0, 0);
  });
});

describe('guidanceAt — băng chỉ dẫn theo vị trí', () => {
  const offsets = stepOffsets([
    step('Xuất phát vào Lê Văn Lương', 800),
    step('Rẽ phải vào Trần Duy Hưng', 1200, 'right'),
    step('Đã tới nơi', 0),
  ]);

  it('gắn mốc quãng đường tích luỹ cho từng chỉ dẫn', () => {
    expect(offsets.map((o) => o.startMeters)).toEqual([0, 800, 2000]);
    expect(offsets.map((o) => o.endMeters)).toEqual([800, 2000, 2000]);
  });

  it('đang giữa chặng thì hiện thao tác sắp phải làm kèm số mét còn lại', () => {
    const g = guidanceAt(offsets, 300)!;

    expect(g.stepIndex).toBe(0);
    expect(g.instruction).toBe('Rẽ phải vào Trần Duy Hưng');
    expect(g.distanceToManeuverMeters).toBeCloseTo(500, 5);
    expect(g.imminent).toBe(false);
    expect(g.nextInstruction).toBe('Đã tới nơi');
  });

  it('gần ngã rẽ thì bật cờ "chuẩn bị rẽ"', () => {
    expect(guidanceAt(offsets, 700)!.imminent).toBe(true);
  });

  it('qua ngã rẽ thì chuyển sang chặng kế tiếp', () => {
    const g = guidanceAt(offsets, 900)!;
    expect(g.stepIndex).toBe(1);
    expect(g.instruction).toBe('Đã tới nơi');
  });

  it('đi hết tuyến vẫn trả về chỉ dẫn cuối, không văng lỗi', () => {
    expect(guidanceAt(offsets, 99_999)!.stepIndex).toBe(2);
    expect(guidanceAt([], 0)).toBeNull();
  });
});

describe('maneuverIcon — hiểu cả mã OSRM lẫn mã Google', () => {
  it('OSRM: type + modifier', () => {
    expect(maneuverIcon('turn', 'right')).toBe('➡️');
    expect(maneuverIcon('turn', 'left')).toBe('⬅️');
    expect(maneuverIcon('arrive')).toBe('🏁');
    expect(maneuverIcon('roundabout')).toBe('🔄');
    expect(maneuverIcon('continue', 'straight')).toBe('⬆️');
  });

  it('Google: một trường maneuver viết hoa, KHÔNG có modifier', () => {
    // Đây là chỗ dễ sai nhất: không xử lý bộ mã này thì mọi cú rẽ của Google
    // đều hiện mũi tên đi thẳng.
    expect(maneuverIcon('TURN_RIGHT')).toBe('➡️');
    expect(maneuverIcon('TURN_LEFT')).toBe('⬅️');
    expect(maneuverIcon('DESTINATION_LEFT')).toBe('🏁');
    expect(maneuverIcon('ROUNDABOUT_RIGHT')).toBe('🔄');
    expect(maneuverIcon('DEPART')).toBe('🚩');
  });

  it('mã lạ thì trả mũi tên đi thẳng chứ không để trống', () => {
    expect(maneuverIcon('KHONG_BIET_LA_GI')).toBe('⬆️');
  });
});

describe('legBoundaries / activeLegIndex — điểm giao kế tiếp', () => {
  const boundaries = legBoundaries([
    { distanceMeters: 1000, durationSeconds: 120 },
    { distanceMeters: 2000, durationSeconds: 240 },
    { distanceMeters: 500, durationSeconds: 60 },
  ]);

  it('mốc đầu luôn là 0 và cộng dồn theo từng chặng', () => {
    expect(boundaries).toEqual([0, 1000, 3000, 3500]);
  });

  it('xác định đúng waypoint xe đang hướng tới', () => {
    expect(activeLegIndex(boundaries, 0)).toBe(1);
    expect(activeLegIndex(boundaries, 999)).toBe(1);
    expect(activeLegIndex(boundaries, 1000)).toBe(2);
    expect(activeLegIndex(boundaries, 3200)).toBe(3);
    // Đi hết tuyến: giữ nguyên waypoint cuối chứ không trả về -1.
    expect(activeLegIndex(boundaries, 9999)).toBe(3);
  });
});

describe('etaSeconds', () => {
  it('ưu tiên tốc độ thực đo được thay vì tốc độ trung bình của máy chủ định tuyến', () => {
    const base = { remainingMeters: 6000, routeMeters: 12_000, routeSeconds: 1200 }; // 10 m/s

    expect(etaSeconds(base)).toBe(600);
    // Xe đang bò 5 m/s -> thời gian phải gấp đôi, không được bám con số kế hoạch.
    expect(etaSeconds({ ...base, observedSpeedMps: 5 })).toBe(1200);
  });

  it('cộng thời gian đứng giao hàng của các điểm còn lại', () => {
    const eta = etaSeconds({
      remainingMeters: 6000,
      routeMeters: 12_000,
      routeSeconds: 1200,
      stopsAhead: 3,
      serviceSecondsPerStop: 600,
    });

    expect(eta).toBe(600 + 1800);
  });

  it('tốc độ thực gần bằng 0 (đang tắc/đang giao) thì rơi về tốc độ kế hoạch', () => {
    const eta = etaSeconds({
      remainingMeters: 6000,
      routeMeters: 12_000,
      routeSeconds: 1200,
      observedSpeedMps: 0.1,
    });

    expect(eta).toBe(600);
  });
});

describe('updateOffRoute — phát hiện đi sai đường', () => {
  const opts = DEFAULT_OFF_ROUTE_OPTIONS;

  it('một bản ghi nhiễu đơn lẻ KHÔNG làm hệ thống định tuyến lại', () => {
    let state = updateOffRoute(INITIAL_OFF_ROUTE_STATE, 200, opts);

    expect(state.offRoute).toBe(false);
    expect(state.consecutive).toBe(1);

    state = updateOffRoute(state, 5, opts);
    expect(state.consecutive).toBe(0);
    expect(state.offRoute).toBe(false);
  });

  it('lệch liên tiếp đủ số lần mới kết luận, và chỉ báo định tuyến lại đúng MỘT lần', () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    for (let i = 0; i < opts.confirmFixes; i++) state = updateOffRoute(state, 200, opts);

    expect(state.offRoute).toBe(true);
    expect(state.justTriggered).toBe(true);

    state = updateOffRoute(state, 250, opts);
    expect(state.offRoute).toBe(true);
    // Vẫn đang sai đường nhưng không được bắn thêm lệnh định tuyến lại nữa.
    expect(state.justTriggered).toBe(false);
  });

  it('vùng xám giữa hai ngưỡng giữ nguyên kết luận cũ (trễ Schmitt)', () => {
    let state = INITIAL_OFF_ROUTE_STATE;
    for (let i = 0; i < opts.confirmFixes; i++) state = updateOffRoute(state, 200, opts);

    // 45 m: đã dưới ngưỡng vào (60) nhưng chưa dưới ngưỡng thoát (30).
    state = updateOffRoute(state, 45, opts);
    expect(state.offRoute).toBe(true);

    state = updateOffRoute(state, 20, opts);
    expect(state.offRoute).toBe(false);
    expect(state.consecutive).toBe(0);
  });
});
