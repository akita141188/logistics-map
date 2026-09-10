import { describe, expect, it } from 'vitest';
import { CostLike, VrpStop, VrpVehicle, routeCost, solveCvrp } from './vrp.util';
import { LatLng } from './map.types';
import { distanceMeters } from './geo.util';

/** Ma trận Haversine cho [kho, ...điểm] — đủ dùng để kiểm tra logic thuật toán. */
function matrixOf(depot: LatLng, stops: readonly VrpStop[]): CostLike {
  const points = [depot, ...stops];
  const n = points.length;

  const distances = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const durations = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const m = distanceMeters(points[i], points[j]);
      distances[i][j] = m;
      durations[i][j] = m / 6.67; // ~24 km/h
    }
  }

  return { distances, durations };
}

const DEPOT: LatLng = { lat: 21.0447, lng: 105.8752 };

/** 3 cụm điểm ở 3 hướng khác nhau — bài toán có lời giải rõ ràng. */
function clusteredStops(): VrpStop[] {
  const clusters = [
    { lat: 21.02, lng: 105.85 }, // tây nam
    { lat: 21.08, lng: 105.9 }, // đông bắc
    { lat: 20.98, lng: 105.79 }, // tây nam xa
  ];

  return clusters.flatMap((c, ci) =>
    Array.from({ length: 3 }, (_, i) => ({
      id: `S${ci}-${i}`,
      lat: c.lat + i * 0.004,
      lng: c.lng + i * 0.004,
      demand: 300,
    })),
  );
}

describe('solveCvrp — chia tuyến có ràng buộc tải trọng', () => {
  it('xếp hết đơn khi tổng tải trọng đủ', () => {
    const stops = clusteredStops(); // 9 đơn × 300 kg = 2.700 kg
    const vehicles: VrpVehicle[] = [
      { id: 'V1', name: 'Xe 1', capacity: 1500 },
      { id: 'V2', name: 'Xe 2', capacity: 1500 },
    ];

    const solution = solveCvrp(stops, vehicles, matrixOf(DEPOT, stops));
    const assigned = solution.routes.flatMap((r) => r.stopIds);

    expect(solution.unassigned).toHaveLength(0);
    expect(assigned).toHaveLength(stops.length);
    // Không đơn nào bị xếp vào hai xe.
    expect(new Set(assigned).size).toBe(stops.length);
  });

  it('KHÔNG BAO GIỜ để một xe vượt tải trọng của nó', () => {
    const stops = clusteredStops();
    const vehicles: VrpVehicle[] = [
      { id: 'V1', name: 'Xe 1', capacity: 1000 },
      { id: 'V2', name: 'Xe 2', capacity: 1000 },
      { id: 'V3', name: 'Xe 3', capacity: 1000 },
    ];

    const solution = solveCvrp(stops, vehicles, matrixOf(DEPOT, stops));

    for (const route of solution.routes) {
      expect(route.load).toBeLessThanOrEqual(route.capacity);
    }
  });

  it('thiếu tải trọng thì trả về danh sách chưa phân xe, không nhét quá tải', () => {
    const stops = clusteredStops(); // 2.700 kg
    const vehicles: VrpVehicle[] = [{ id: 'V1', name: 'Xe 1', capacity: 900 }];

    const solution = solveCvrp(stops, vehicles, matrixOf(DEPOT, stops));

    expect(solution.unassigned.length).toBeGreaterThan(0);
    expect(solution.routes.every((r) => r.load <= r.capacity)).toBe(true);

    // Mọi đơn đều phải xuất hiện đúng một lần: hoặc trên xe, hoặc ở danh sách thừa.
    const all = [...solution.routes.flatMap((r) => r.stopIds), ...solution.unassigned];
    expect(new Set(all).size).toBe(stops.length);
  });

  it('tôn trọng trần số điểm mỗi chuyến', () => {
    const stops = clusteredStops();
    const vehicles: VrpVehicle[] = [
      { id: 'V1', name: 'Xe 1', capacity: 9999, maxStops: 3 },
      { id: 'V2', name: 'Xe 2', capacity: 9999, maxStops: 3 },
      { id: 'V3', name: 'Xe 3', capacity: 9999, maxStops: 3 },
    ];

    const solution = solveCvrp(stops, vehicles, matrixOf(DEPOT, stops));

    for (const route of solution.routes) {
      expect(route.stopIds.length).toBeLessThanOrEqual(3);
    }
  });

  it('gộp chuyến tiết kiệm đường thật so với mỗi đơn một chuyến', () => {
    const stops = clusteredStops();
    const vehicles: VrpVehicle[] = [
      { id: 'V1', name: 'Xe 1', capacity: 1500 },
      { id: 'V2', name: 'Xe 2', capacity: 1500 },
    ];

    const solution = solveCvrp(stops, vehicles, matrixOf(DEPOT, stops));

    expect(solution.naiveDistanceMeters).toBeGreaterThan(0);
    expect(solution.totalDistanceMeters).toBeLessThan(solution.naiveDistanceMeters);
  });

  it('gom các điểm cùng cụm vào cùng một xe', () => {
    const stops = clusteredStops();
    const vehicles: VrpVehicle[] = [
      { id: 'V1', name: 'Xe 1', capacity: 900 },
      { id: 'V2', name: 'Xe 2', capacity: 900 },
      { id: 'V3', name: 'Xe 3', capacity: 900 },
    ];

    const solution = solveCvrp(stops, vehicles, matrixOf(DEPOT, stops));

    // Với tải trọng vừa đúng 3 đơn/xe và 3 cụm tách biệt, lời giải hợp lý là
    // mỗi xe gánh trọn một cụm. Kiểm tra bằng tiền tố id cụm.
    for (const route of solution.routes) {
      const clusterIds = new Set(route.stopIds.map((id) => id.split('-')[0]));
      expect(clusterIds.size).toBe(1);
    }
  });

  it('trả về rỗng an toàn khi ma trận sai kích thước (sai quy ước chỉ số)', () => {
    const stops = clusteredStops();
    // Ma trận thiếu hàng cho kho -> chỉ số lệch, mọi con số sẽ thuộc về điểm khác.
    const broken: CostLike = { distances: [[0]], durations: [[0]] };

    const solution = solveCvrp(stops, [{ id: 'V1', name: 'Xe', capacity: 9999 }], broken);

    expect(solution.routes).toHaveLength(0);
    expect(solution.unassigned).toHaveLength(stops.length);
  });

  it('không xe nào thì mọi đơn đều nằm ở danh sách chưa phân xe', () => {
    const stops = clusteredStops();
    const solution = solveCvrp(stops, [], matrixOf(DEPOT, stops));

    expect(solution.unassigned).toHaveLength(stops.length);
  });
});

describe('routeCost', () => {
  it('cộng cả đoạn đi từ kho và đoạn quay về kho', () => {
    const stops = clusteredStops().slice(0, 2);
    const matrix = matrixOf(DEPOT, stops);

    const cost = routeCost([1, 2], matrix);
    const expected =
      matrix.distances[0][1] + matrix.distances[1][2] + matrix.distances[2][0];

    expect(cost.distance).toBeCloseTo(expected, 5);
  });

  it('cộng thời gian đứng giao tại mỗi điểm', () => {
    const stops = clusteredStops().slice(0, 3);
    const matrix = matrixOf(DEPOT, stops);

    const withoutService = routeCost([1, 2, 3], matrix, 0);
    const withService = routeCost([1, 2, 3], matrix, 600);

    // `toBeCloseTo` chứ không `toBe`: phần thời gian chạy được cộng dồn từ số
    // thực, nên hiệu hai tổng ra 1799.9999999999998 chứ không tròn 1800.
    expect(withService.duration - withoutService.duration).toBeCloseTo(3 * 600, 6);
  });

  it('chuyến rỗng có chi phí bằng 0, không phải NaN', () => {
    const cost = routeCost([], matrixOf(DEPOT, clusteredStops()));
    expect(cost.distance).toBe(0);
    expect(cost.duration).toBe(0);
  });
});
