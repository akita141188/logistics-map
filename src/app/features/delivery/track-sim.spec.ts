import { describe, expect, it } from 'vitest';
import { LatLng } from '../../core/map/map.types';
import {
  destinationPoint,
  distanceToPathMeters,
  totalDistanceMeters,
} from '../../core/map/geo.util';
import { cumulativeAlong } from '../../core/map/navigation.util';
import {
  applyGpsNoise,
  distributeSeconds,
  segmentSpeedWeights,
  simulateTrack,
  smoothNoise,
  straightnessProfile,
} from './track-sim.util';

/** Đường thẳng theo hướng đông, mỗi đỉnh cách nhau `stepMeters`. */
function straightPath(count: number, stepMeters = 50): LatLng[] {
  const path: LatLng[] = [{ lat: 21, lng: 105.8 }];
  for (let i = 1; i < count; i++) path.push(destinationPoint(path[i - 1], 90, stepMeters));
  return path;
}

/** Đường bẻ vuông góc ở giữa: nửa đầu đi về đông, nửa sau đi lên bắc. */
function rightAnglePath(): LatLng[] {
  const path: LatLng[] = [{ lat: 21, lng: 105.8 }];
  for (let i = 0; i < 12; i++) path.push(destinationPoint(path[path.length - 1], 90, 40));
  for (let i = 0; i < 12; i++) path.push(destinationPoint(path[path.length - 1], 0, 40));
  return path;
}

describe('straightnessProfile', () => {
  it('đường thẳng thì mọi đỉnh đều thẳng tuyệt đối', () => {
    const profile = straightnessProfile(straightPath(10), 140);
    for (const s of profile) expect(s).toBeCloseTo(1, 3);
  });

  it('đỉnh ở chỗ bẻ vuông góc tụt về ~0', () => {
    const path = rightAnglePath();
    const profile = straightnessProfile(path, 140);

    // Đỉnh số 12 là chỗ bẻ góc.
    expect(profile[12]).toBeLessThan(0.2);
    // Còn giữa đoạn thẳng thì vẫn thẳng.
    expect(profile[4]).toBeGreaterThan(0.9);
  });

  /**
   * Cái bẫy: khúc cua được rải thành 40 đỉnh, mỗi đỉnh chỉ bẻ 2,25°. Đo góc giữa
   * hai đoạn liền kề thì khúc ngoặt 90° này bị chấm là "thẳng tắp".
   */
  it('nhận ra khúc cua kể cả khi nó được rải thành hàng chục đỉnh li ti', () => {
    // Cung tròn 90° rải 40 đỉnh × 8 m = 320 m.
    const path: LatLng[] = [{ lat: 21, lng: 105.8 }];
    for (let i = 1; i <= 40; i++) {
      path.push(destinationPoint(path[i - 1], 90 - (i / 40) * 90, 8));
    }

    const wide = straightnessProfile(path, 160);
    expect(Math.min(...wide)).toBeLessThan(0.75);
  });

  /**
   * Tính chất quan trọng nhất: kết quả KHÔNG phụ thuộc mật độ đỉnh. Cùng một khúc
   * cua, chia làm 5 đoạn hay 500 đoạn đều phải cho ra cùng một mức phạt — nếu
   * không thì đổi nhà cung cấp bản đồ là biểu đồ tốc độ đổi theo.
   */
  it('mật độ đỉnh không làm đổi kết quả', () => {
    const arc = (steps: number): LatLng[] => {
      const path: LatLng[] = [{ lat: 21, lng: 105.8 }];
      for (let i = 1; i <= steps; i++) {
        path.push(destinationPoint(path[i - 1], 90 - (i / steps) * 90, 320 / steps));
      }
      return path;
    };

    const coarse = Math.min(...straightnessProfile(arc(8), 160));
    const fine = Math.min(...straightnessProfile(arc(80), 160));

    // Không bằng nhau tuyệt đối: ranh giới cửa sổ phải bám vào đỉnh nên với
    // polyline thưa nó bị làm tròn. Cái cần bảo đảm là mức chênh nhỏ hơn hẳn
    // khoảng cách giữa "thẳng" (1) và "ngoặt gắt" (0).
    expect(Math.abs(coarse - fine)).toBeLessThan(0.2);
  });
});

describe('segmentSpeedWeights + distributeSeconds', () => {
  it('tổng thời gian rải ra đúng bằng thời gian yêu cầu', () => {
    const path = rightAnglePath();
    const seconds = distributeSeconds(path, segmentSpeedWeights(path), 600);

    expect(seconds).toHaveLength(path.length);
    expect(seconds[0]).toBe(0);
    expect(seconds[seconds.length - 1]).toBeCloseTo(600, 6);
  });

  it('mốc thời gian luôn tăng dần', () => {
    const path = rightAnglePath();
    const seconds = distributeSeconds(path, segmentSpeedWeights(path), 600);

    for (let i = 1; i < seconds.length; i++) expect(seconds[i]).toBeGreaterThan(seconds[i - 1]);
  });

  /**
   * Đây là lý do cả cơ chế này tồn tại: rải thời gian đều theo quãng đường thì xe
   * chạy đúng một tốc độ từ đầu tới cuối chuyến, và mọi cảnh báo dựa trên tốc độ
   * đều chết lâm sàng.
   */
  it('qua khúc cua thì chậm hẳn so với đoạn thẳng', () => {
    const path = rightAnglePath();
    const seconds = distributeSeconds(path, segmentSpeedWeights(path), 600);

    // Các đoạn đều dài 40 m -> thời gian mỗi đoạn phản ánh đúng tốc độ.
    const corner = seconds[13] - seconds[12];
    const straight = seconds[5] - seconds[4];

    expect(corner).toBeGreaterThan(straight * 2);
  });

  it('tuyến suy biến (mọi đỉnh trùng nhau) vẫn ra thời gian hợp lệ', () => {
    const same: LatLng[] = Array.from({ length: 4 }, () => ({ lat: 21, lng: 105.8 }));
    const seconds = distributeSeconds(same, segmentSpeedWeights(same), 300);

    expect(seconds).toHaveLength(4);
    expect(seconds.every((s) => Number.isFinite(s))).toBe(true);
    expect(seconds[3]).toBeCloseTo(300, 6);
  });
});

describe('applyGpsNoise', () => {
  it('tất định — hai lần gọi cho kết quả y hệt', () => {
    const path = straightPath(30);
    expect(applyGpsNoise(path, 8, 3)).toEqual(applyGpsNoise(path, 8, 3));
  });

  it('không đẩy điểm ra xa quá biên độ đã khai', () => {
    const path = straightPath(60);
    const noisy = applyGpsNoise(path, 8);

    const worst = Math.max(...noisy.map((p) => distanceToPathMeters(p, path)));
    expect(worst).toBeGreaterThan(1); // có nhiễu thật, không phải hàm rỗng
    expect(worst).toBeLessThanOrEqual(8 + 1e-6);
  });

  /**
   * ====== ĐIỂM MẤU CHỐT: NHIỄU PHẢI LỆCH NGANG, KHÔNG LỆCH DỌC ======
   *
   * Nhiễu trắng cộng thẳng vào lat/lng có thành phần DỌC đường. Sai số dọc đường
   * được CỘNG DỒN vào quãng đường thực tế nên luôn thổi phồng số km — thứ mà
   * doanh nghiệp có thể đang dùng để khoán xăng.
   */
  it('lệch ngang nên hầu như không làm phồng quãng đường', () => {
    const path = straightPath(120, 40);
    const clean = totalDistanceMeters(path);

    const lateral = totalDistanceMeters(applyGpsNoise(path, 8));

    // Nhiễu trắng cùng biên độ, để đối chứng.
    const white = path.map((p, i) => ({
      lat: p.lat + (smoothNoise(i * 997, 1) * 8) / 111_320,
      lng: p.lng + (smoothNoise(i * 997, 2) * 8) / (111_320 * Math.cos((21 * Math.PI) / 180)),
    }));
    const whiteTotal = totalDistanceMeters(white);

    expect(Math.abs(lateral - clean) / clean).toBeLessThan(0.005);
    expect(Math.abs(whiteTotal - clean) / clean).toBeGreaterThan(Math.abs(lateral - clean) / clean);
  });

  it('nhiễu TRƠN, không răng cưa — hai mẫu liền nhau lệch gần như nhau', () => {
    const path = straightPath(80, 40);
    const noisy = applyGpsNoise(path, 8);

    // Độ lệch giữa hai mẫu cách nhau 40 m phải nhỏ hơn nhiều so với biên độ.
    for (let i = 1; i < noisy.length; i++) {
      const a = distanceToPathMeters(noisy[i - 1], path);
      const b = distanceToPathMeters(noisy[i], path);
      expect(Math.abs(a - b)).toBeLessThan(4);
    }
  });
});

describe('simulateTrack', () => {
  const path = straightPath(200, 25); // ~5 km

  function run() {
    return simulateTrack({
      path,
      stops: [
        { alongMeters: 1500, dwellSeconds: 600, driveSeconds: 300 },
        { alongMeters: 3500, dwellSeconds: 900, driveSeconds: 400 },
      ],
      departureMs: Date.UTC(2026, 8, 9, 7, 0, 0),
      tailDriveSeconds: 200,
      parkedSampleSeconds: 90,
    });
  }

  it('mốc thời gian tăng đơn điệu suốt chuyến', () => {
    const samples = run();
    expect(samples.length).toBeGreaterThan(50);

    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].timeMs).toBeGreaterThanOrEqual(samples[i - 1].timeMs);
    }
  });

  it('giờ tới từng điểm đúng bằng lăn bánh + đứng chờ cộng dồn', () => {
    const samples = run();
    const departure = Date.UTC(2026, 8, 9, 7, 0, 0);

    // Điểm 1: 300 s lăn bánh.
    const firstParked = samples.find((s) => s.parked)!;
    expect((firstParked.timeMs - departure) / 1000).toBeGreaterThanOrEqual(300);

    // Điểm 2: 300 + 600 (đứng ở điểm 1) + 400 = 1300 s.
    const parkedRuns = samples.filter((s) => s.parked);
    const secondRunStart = parkedRuns.find((s) => s.timeMs - departure > 1000 * 1000)!;
    expect((secondRunStart.timeMs - departure) / 1000).toBeGreaterThanOrEqual(1300);
  });

  it('lúc đỗ giao hàng: toạ độ đứng yên, tốc độ 0, thiết bị vẫn bắn log', () => {
    const samples = run();
    const parked = samples.filter((s) => s.parked);

    // 600s/90s + 900s/90s = 7 + 10 mẫu.
    expect(parked.length).toBeGreaterThanOrEqual(15);
    expect(parked.every((s) => s.speedKmh === 0)).toBe(true);

    // Các mẫu trong cùng một lần đỗ phải trùng toạ độ.
    const firstGroup = parked.slice(0, 5);
    for (const s of firstGroup) {
      expect(s.point.lat).toBeCloseTo(firstGroup[0].point.lat, 9);
      expect(s.point.lng).toBeCloseTo(firstGroup[0].point.lng, 9);
    }
  });

  it('mọi mẫu đều nằm TRÊN tuyến đã cho — không mẫu nào cắt qua chỗ khác', () => {
    const samples = run();
    const worst = Math.max(...samples.map((s) => distanceToPathMeters(s.point, path)));
    expect(worst).toBeLessThan(1e-6);
  });

  it('đi hết tuyến, không dừng giữa chừng', () => {
    const samples = run();
    const cum = cumulativeAlong(path);
    const last = samples[samples.length - 1].point;

    expect(distanceToPathMeters(last, [path[path.length - 2], path[path.length - 1]])).toBeLessThan(
      1e-6,
    );
    expect(cum[cum.length - 1]).toBeGreaterThan(4000);
  });

  it('tuyến quá ngắn thì trả mảng rỗng thay vì ném lỗi', () => {
    expect(
      simulateTrack({
        path: [{ lat: 21, lng: 105.8 }],
        stops: [],
        departureMs: 0,
        tailDriveSeconds: 10,
        parkedSampleSeconds: 90,
      }),
    ).toEqual([]);
  });
});
