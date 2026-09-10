import { describe, expect, it } from 'vitest';
import { LatLng } from './map.types';
import {
  distanceMeters,
  distanceToPathMeters,
  resampleAlongPath,
  totalDistanceMeters,
} from './geo.util';

/**
 * ============ LẤY MẪU LẠI POLYLINE — CHỈ THÊM, KHÔNG BAO GIỜ BỚT ============
 *
 * Bộ test này khoá lại bài học đắt nhất của màn Giám sát lộ trình: mọi cách rút
 * gọn hình học tuyến đường theo CHỈ SỐ MẢNG đều sai, vì đỉnh của một tuyến không
 * rải đều — dịch vụ định tuyến đặt đỉnh dày ở khúc cua và thưa ở đoạn thẳng dài.
 */

/** Tuyến hình chữ L có đỉnh DÀY ở khúc cua và THƯA ở đoạn thẳng — như tuyến thật. */
function elbowPath(): LatLng[] {
  const path: LatLng[] = [];

  // Đoạn thẳng dài, chỉ 2 đỉnh (mô phỏng đoạn đại lộ).
  path.push({ lat: 21.0, lng: 105.8 });
  path.push({ lat: 21.0, lng: 105.82 });

  // Khúc cua 90°, 20 đỉnh sát nhau (mô phỏng chỗ rẽ ở ngã tư).
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    const angle = (t * Math.PI) / 2;
    path.push({
      lat: 21.0 + 0.002 * (1 - Math.cos(angle)),
      lng: 105.82 + 0.002 * Math.sin(angle),
    });
  }

  path.push({ lat: 21.02, lng: 105.822 });
  return path;
}

describe('resampleAlongPath', () => {
  it('giữ nguyên 100% đỉnh gốc', () => {
    const path = elbowPath();
    const dense = resampleAlongPath(path, 30);

    // Mọi đỉnh gốc phải xuất hiện y nguyên trong kết quả.
    for (const original of path) {
      const found = dense.some(
        (p) => Math.abs(p.lat - original.lat) < 1e-12 && Math.abs(p.lng - original.lng) < 1e-12,
      );
      expect(found).toBe(true);
    }
  });

  it('không đoạn nào dài quá ngưỡng', () => {
    const dense = resampleAlongPath(elbowPath(), 30);

    for (let i = 1; i < dense.length; i++) {
      // +1e-6 cho sai số dấu phẩy động.
      expect(distanceMeters(dense[i - 1], dense[i])).toBeLessThanOrEqual(30 + 1e-6);
    }
  });

  it('sai số hình học đúng bằng 0 — điểm mới luôn nằm trên tuyến cũ', () => {
    const path = elbowPath();
    const dense = resampleAlongPath(path, 25);

    const worst = Math.max(...dense.map((p) => distanceToPathMeters(p, path)));
    expect(worst).toBeLessThan(1e-6);
  });

  it('giữ nguyên chiều dài tuyến', () => {
    const path = elbowPath();
    const dense = resampleAlongPath(path, 25);

    expect(totalDistanceMeters(dense)).toBeCloseTo(totalDistanceMeters(path), 3);
  });

  /**
   * ĐÂY LÀ CÁI BẪY ĐÃ LÀM HỎNG MÀN GIÁM SÁT.
   *
   * Cùng một tuyến, cùng mục tiêu "giảm số điểm": lấy mẫu theo chỉ số mảng cắt
   * phăng khúc cua, còn `resampleAlongPath` thì không đụng tới hình học.
   */
  it('lấy mẫu theo CHỈ SỐ MẢNG thì cắt mất khúc cua — cách làm cũ', () => {
    const path = elbowPath();
    const byIndex = path.filter((_, i) => i % 4 === 0);

    const worstByIndex = Math.max(...path.map((p) => distanceToPathMeters(p, byIndex)));
    const worstByResample = Math.max(
      ...path.map((p) => distanceToPathMeters(p, resampleAlongPath(path, 40))),
    );

    // Lấy mẫu theo chỉ số đẩy đường vẽ ra xa mặt đường hàng chục mét...
    expect(worstByIndex).toBeGreaterThan(10);
    // ...trong khi cách mới không lệch một mi-li-mét nào.
    expect(worstByResample).toBeLessThan(1e-6);
  });

  it('tuyến rỗng / một điểm / ngưỡng vô nghĩa đều không làm vỡ hàm', () => {
    expect(resampleAlongPath([], 10)).toEqual([]);
    expect(resampleAlongPath([{ lat: 1, lng: 2 }], 10)).toEqual([{ lat: 1, lng: 2 }]);
    expect(resampleAlongPath(elbowPath(), 0)).toHaveLength(elbowPath().length);
  });
});
