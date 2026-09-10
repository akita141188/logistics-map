import { describe, expect, it } from 'vitest';
import {
  cleanTrack,
  detectStops,
  findGaps,
  secondsBetween,
  speedProfileKmh,
  summarizeTrack,
} from './gps-quality.util';
import { RoutePoint } from './map.types';
import { totalDistanceMeters } from './geo.util';

/**
 * Dựng một chuỗi điểm GPS chạy thẳng theo hướng đông, giãn cách đều.
 *
 * `metersPerStep` quy đổi sang độ kinh tuyến tại vĩ độ 21° (Hà Nội):
 * 1° kinh độ ≈ 111.320 m × cos(21°) ≈ 103.900 m.
 */
function straightTrack(
  count: number,
  metersPerStep: number,
  secondsPerStep: number,
  startIso = '2026-09-09T07:00:00.000Z',
): RoutePoint[] {
  const degPerMeter = 1 / (111_320 * Math.cos((21 * Math.PI) / 180));
  const start = new Date(startIso).getTime();

  return Array.from({ length: count }, (_, i) => ({
    lat: 21,
    lng: 105.8 + i * metersPerStep * degPerMeter,
    createDate: new Date(start + i * secondsPerStep * 1000).toISOString(),
  }));
}

describe('cleanTrack — lọc nhiễu GPS', () => {
  it('loại điểm nhảy cóc phi vật lý nhưng giữ nguyên phần còn lại', () => {
    const track = straightTrack(10, 100, 30); // 100 m / 30 s = 12 km/h

    // Chèn một điểm cách 5 km chỉ sau 30 giây -> 600 km/h, chắc chắn là rác.
    track.splice(5, 0, {
      lat: 21.05,
      lng: 105.85,
      createDate: new Date(new Date(track[4].createDate!).getTime() + 30_000).toISOString(),
    });

    const result = cleanTrack(track, { maxSpeedKmh: 130, minSpacingMeters: 0 });

    expect(result.removedOutliers).toBe(1);
    expect(result.points).toHaveLength(10);
  });

  it('gộp các điểm rung khi xe đứng yên', () => {
    // 20 điểm nằm trong bán kính ~2 m, cách nhau 30 giây: xe đỗ, thiết bị vẫn bắn log.
    const idle: RoutePoint[] = Array.from({ length: 20 }, (_, i) => ({
      lat: 21 + (i % 3) * 0.00001,
      lng: 105.8 + (i % 2) * 0.00001,
      createDate: new Date(Date.UTC(2026, 8, 9, 7, 0, 0) + i * 30_000).toISOString(),
    }));

    const result = cleanTrack(idle, { minSpacingMeters: 8, maxStationarySeconds: 5 * 60 });

    // 20 điểm × 30 s = 9,5 phút đứng yên -> gộp gần hết, nhưng giữ lại nhịp mốc
    // mỗi 5 phút để không biến chỗ đỗ thành chỗ "mất tín hiệu".
    expect(result.points).toHaveLength(2);
    expect(result.removedJitter).toBe(18);

    // Gộp xong vẫn không được cộng thêm mét nào đáng kể.
    expect(totalDistanceMeters(result.points)).toBeLessThan(5);
  });

  /**
   * Gộp nhiễu SẠCH thì xoá luôn bằng chứng rằng thiết bị vẫn báo về, và một chiếc
   * xe đang đỗ giao hàng bị `findGaps` kết luận là mất tín hiệu.
   */
  it('xe đỗ lâu vẫn giữ nhịp bản ghi, không bị hiểu nhầm thành mất tín hiệu', () => {
    // Đỗ 40 phút, thiết bị bắn log mỗi 90 giây, toạ độ rung trong bán kính 2 m.
    const parked: RoutePoint[] = Array.from({ length: 27 }, (_, i) => ({
      lat: 21 + (i % 3) * 0.00001,
      lng: 105.8 + (i % 2) * 0.00001,
      createDate: new Date(Date.UTC(2026, 8, 9, 7, 0, 0) + i * 90_000).toISOString(),
    }));

    const cleaned = cleanTrack(parked, { minSpacingMeters: 8, maxStationarySeconds: 5 * 60 });

    // Ngưỡng "đứt track" 15 phút không được chạm tới.
    expect(findGaps(cleaned.points, 15 * 60)).toHaveLength(0);
  });

  it('phần "đường ma" do nhiễu bị cắt khỏi quãng đường thực tế', () => {
    const moving = straightTrack(10, 120, 30);

    // Xen kẽ điểm rung quanh vị trí cuối — mô phỏng 10 phút đỗ giao hàng.
    const parked: RoutePoint[] = Array.from({ length: 20 }, (_, i) => ({
      lat: moving[9].lat + (i % 4) * 0.00002,
      lng: moving[9].lng + (i % 3) * 0.00002,
      createDate: new Date(
        new Date(moving[9].createDate!).getTime() + (i + 1) * 30_000,
      ).toISOString(),
    }));

    const raw = [...moving, ...parked];
    const cleaned = cleanTrack(raw, { minSpacingMeters: 8 });

    const rawMeters = totalDistanceMeters(raw);
    const cleanMeters = totalDistanceMeters(cleaned.points);

    // Nhiễu khi đỗ luôn làm quãng đường thô DÀI hơn — đó chính là sai số cần cắt.
    expect(rawMeters).toBeGreaterThan(cleanMeters);

    // Sau khi lọc, chỉ còn đúng 9 đoạn × 120 m.
    // Dung sai 1% chứ không phải tuyệt đối: chuỗi điểm test dựng bằng phép xấp xỉ
    // mặt phẳng ("1° kinh độ = 111.320 × cos φ"), còn `distanceMeters` dùng
    // Haversine trên mặt cầu. Hai cách lệch nhau ~0,1% — bám sát hơn nữa là đang
    // kiểm tra phép xấp xỉ của chính test, không phải kiểm tra hàm lọc nhiễu.
    expect(cleanMeters).toBeGreaterThan(9 * 120 * 0.99);
    expect(cleanMeters).toBeLessThan(9 * 120 * 1.01);
  });

  it('không xoá điểm khi thiếu mốc thời gian (không có cơ sở tính tốc độ)', () => {
    const track: RoutePoint[] = [
      { lat: 21, lng: 105.8 },
      { lat: 21.05, lng: 105.85 }, // cách ~7 km, nhưng không biết mất bao lâu
    ];

    const result = cleanTrack(track);

    expect(result.removedOutliers).toBe(0);
    expect(result.points).toHaveLength(2);
  });
});

describe('findGaps — phát hiện mất tín hiệu', () => {
  it('bắt được khoảng trống vượt ngưỡng và bỏ qua khoảng bình thường', () => {
    const track = straightTrack(5, 100, 30);

    // Đẩy 2 điểm cuối muộn thêm 40 phút: app bị kill giữa chừng.
    for (let i = 3; i < 5; i++) {
      track[i].createDate = new Date(
        new Date(track[i].createDate!).getTime() + 40 * 60_000,
      ).toISOString();
    }

    const gaps = findGaps(track, 15 * 60);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].index).toBe(2);
    expect(gaps[0].minutes).toBeGreaterThanOrEqual(40);
  });
});

describe('speedProfileKmh — tốc độ tính từ toạ độ + thời gian', () => {
  it('cho đúng tốc độ trung bình đoạn, không phụ thuộc trường speed của thiết bị', () => {
    // 200 m mỗi 20 giây = 10 m/s = 36 km/h.
    const track = straightTrack(6, 200, 20);
    const speeds = speedProfileKmh(track);

    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeCloseTo(36, 0);
    }
  });

  it('không chia cho 0 khi hai bản ghi trùng mốc thời gian', () => {
    const track = straightTrack(3, 100, 0);
    const speeds = speedProfileKmh(track);

    expect(speeds.every((s) => Number.isFinite(s))).toBe(true);
  });
});

describe('detectStops — phát hiện điểm dừng', () => {
  it('gom một lần đỗ dài thành MỘT sự kiện, không phải hàng chục mẩu vụn', () => {
    const before = straightTrack(5, 150, 60);

    // Đỗ 30 phút tại chỗ, mỗi phút một bản ghi, nhiễu vài mét.
    const lastMs = new Date(before[4].createDate!).getTime();
    const parked: RoutePoint[] = Array.from({ length: 30 }, (_, i) => ({
      lat: before[4].lat + (i % 5) * 0.00002,
      lng: before[4].lng + (i % 4) * 0.00002,
      createDate: new Date(lastMs + (i + 1) * 60_000).toISOString(),
    }));

    const stops = detectStops([...before, ...parked], { minMinutes: 10, radiusMeters: 60 });

    expect(stops).toHaveLength(1);
    expect(stops[0].minutes).toBeGreaterThanOrEqual(28);
    expect(stops[0].radiusMeters).toBeLessThan(60);
  });

  it('xe chạy liên tục thì không sinh điểm dừng nào', () => {
    const stops = detectStops(straightTrack(40, 200, 30), { minMinutes: 5, radiusMeters: 60 });
    expect(stops).toHaveLength(0);
  });
});

describe('summarizeTrack', () => {
  it('dùng TRUNG VỊ cho nhịp lấy mẫu nên không bị một khoảng trống kéo lệch', () => {
    const track = straightTrack(20, 100, 30);
    // Một lần mất sóng 60 phút — trung bình cộng sẽ vọt lên ~200 s, trung vị vẫn 30 s.
    for (let i = 10; i < 20; i++) {
      track[i].createDate = new Date(
        new Date(track[i].createDate!).getTime() + 60 * 60_000,
      ).toISOString();
    }

    const summary = summarizeTrack(track, cleanTrack(track, { minSpacingMeters: 0 }));

    expect(summary.medianIntervalSeconds).toBe(30);
    expect(summary.gaps).toBe(1);
  });
});

describe('secondsBetween', () => {
  it('trả 0 khi mốc thời gian thiếu hoặc đi lùi, thay vì trả số âm', () => {
    const a: RoutePoint = { lat: 21, lng: 105.8, createDate: '2026-09-09T08:00:00Z' };
    const b: RoutePoint = { lat: 21, lng: 105.8, createDate: '2026-09-09T07:00:00Z' };

    expect(secondsBetween(a, b)).toBe(0);
    expect(secondsBetween({ lat: 21, lng: 105.8 }, a)).toBe(0);
    expect(secondsBetween(b, a)).toBe(3600);
  });
});
