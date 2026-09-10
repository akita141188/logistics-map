import { describe, expect, it } from 'vitest';
import { LatLng } from './map.types';
import {
  bestInsertion,
  insertionCostMeters,
  optimizeWaypointOrder,
  tourLengthMeters,
} from './route-optimizer.util';

/**
 * Tuyến hình chữ L đơn giản, đủ để kiểm tra logic chèn mà vẫn tính nhẩm được:
 *
 *   A(0,0) ── B(0,1) ── C(0,2) ── D(1,2)
 */
const PATH: LatLng[] = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 1 },
  { lat: 0, lng: 2 },
  { lat: 1, lng: 2 },
];

describe('bestInsertion', () => {
  it('chèn điểm nằm ngay trên đoạn đầu vào đúng khe đó, gần như không đội đường', () => {
    // Điểm nằm giữa A và B -> khe 1.
    const result = bestInsertion(PATH, { lat: 0, lng: 0.5 });

    expect(result.index).toBe(1);
    expect(result.extraMeters).toBeLessThan(1);
  });

  it('chèn điểm cạnh đoạn cuối vào khe cuối', () => {
    const result = bestInsertion(PATH, { lat: 0.5, lng: 2 });
    expect(result.index).toBe(3);
  });

  it('tôn trọng minIndex — không chèn vào phần tuyến đã đi qua', () => {
    // Điểm này rẻ nhất ở khe 1, nhưng khe 1 và 2 bị khoá.
    const result = bestInsertion(PATH, { lat: 0, lng: 0.5 }, 3);
    expect(result.index).toBe(3);
  });

  it('chi phí chèn = đường vòng thêm, không phải khoảng cách tới điểm mới', () => {
    // Điểm nằm đúng trên đoạn thẳng -> đi vòng qua nó không tốn thêm gì.
    const onSegment = insertionCostMeters(PATH, { lat: 0, lng: 0.5 }, 1);
    // Điểm lệch hẳn ra ngoài -> phải trả giá.
    const offSegment = insertionCostMeters(PATH, { lat: 0.5, lng: 0.5 }, 1);

    expect(onSegment).toBeLessThan(1);
    // Vòng qua điểm lệch 0.5° ra khỏi trục -> đội thêm hàng chục km.
    expect(offSegment).toBeGreaterThan(40_000);
  });

  it('tuyến chỉ có 1 điểm thì không crash', () => {
    expect(bestInsertion([{ lat: 0, lng: 0 }], { lat: 1, lng: 1 })).toEqual({
      index: 1,
      extraMeters: 0,
    });
  });
});

describe('optimizeWaypointOrder', () => {
  it('gỡ được đoạn bắt chéo và giữ nguyên điểm đầu/cuối', () => {
    // Thứ tự cố tình xấu: đi 0 -> 2 -> 1 -> 3 (bắt chéo).
    const messy: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 3 },
    ];

    const optimized = optimizeWaypointOrder(messy);

    expect(optimized[0]).toEqual(messy[0]);
    expect(optimized[optimized.length - 1]).toEqual(messy[3]);
    expect(tourLengthMeters(optimized)).toBeLessThan(tourLengthMeters(messy));
  });

  it('dưới 4 điểm thì trả nguyên, không hoán vị gì', () => {
    const three = PATH.slice(0, 3);
    expect(optimizeWaypointOrder(three)).toEqual(three);
  });
});
