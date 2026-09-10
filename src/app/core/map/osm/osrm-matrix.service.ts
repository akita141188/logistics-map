import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng } from '../map.types';
import { distanceMeters } from '../geo.util';

interface OsrmTableResponse {
  code: string;
  /** `durations[i][j]` = giây đi từ điểm i tới điểm j. `null` khi không tới được. */
  durations?: (number | null)[][];
  distances?: (number | null)[][];
}

/**
 * Ma trận chi phí giữa mọi cặp điểm.
 * `distances[i][j]` = mét, `durations[i][j]` = giây, đi từ i tới j.
 */
export interface CostMatrix {
  distances: number[][];
  durations: number[][];
  /** `true` = số liệu đường thật; `false` = ước lượng chim bay (server lỗi). */
  real: boolean;
}

/**
 * ========== MA TRẬN KHOẢNG CÁCH THẬT — OSRM `/table/v1` ==========
 *
 * VÌ SAO KHÔNG DÙNG ĐƯỜNG CHIM BAY ĐỂ TỐI ƯU TUYẾN:
 *
 * Thuật toán sắp tuyến (2-opt, Clarke-Wright) cần biết chi phí đi giữa mọi cặp
 * điểm. Lấy Haversine cho nhanh thì sai ở đúng những chỗ quan trọng nhất:
 *
 *  - **Sông**: hai điểm hai bờ Hồng cách nhau 800 m đường chim bay nhưng phải
 *    vòng 6 km qua cầu. Thuật toán tưởng gần, xếp liền nhau, tài xế chạy oan 12 km.
 *  - **Đường một chiều**: đi A->B và B->A khác nhau hoàn toàn. Ma trận thật KHÔNG
 *    đối xứng; chim bay thì luôn đối xứng.
 *  - **Cấm rẽ trái, đường cụt, phố đi bộ theo giờ**: chim bay mù tịt.
 *
 * Với tuyến giao hàng nội đô đông đúc, chênh lệch giữa hai cách này thường
 * 15–30% tổng quãng đường. Đó là tiền xăng và giờ công thật.
 *
 * GIÁ PHẢI TRẢ: `/table` là O(n²) ở phía server. `router.project-osrm.org` chặn
 * ở khoảng vài chục điểm (đo được: 25 điểm vẫn OK). Quá ngưỡng thì service này
 * tự cắt thành các khối con rồi ghép lại — xem `fetchBlock`.
 */
@Injectable({ providedIn: 'root' })
export class OsrmMatrixService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /**
   * Lấy ma trận chi phí cho danh sách điểm.
   *
   * KHÔNG NÉM LỖI: hỏng thì trả ma trận Haversine với `real: false`, để màn hình
   * biết mà ghi chú "đang dùng ước lượng" thay vì hiện bảng trống.
   */
  async getMatrix(points: readonly LatLng[]): Promise<CostMatrix> {
    const n = points.length;
    if (n < 2) return { distances: [[0]], durations: [[0]], real: false };

    try {
      const limit = this.config.osrmMaxTablePoints;

      // Đủ nhỏ -> một request duy nhất, đường thẳng nhất.
      if (n <= limit) return await this.fetchBlock(points, points);

      return await this.fetchTiled(points, limit);
    } catch {
      return this.haversineMatrix(points);
    }
  }

  /**
   * Ma trận lớn: cắt thành các khối `sources × destinations` vừa giới hạn server.
   *
   * OSRM cho phép chỉ định `sources=` và `destinations=` là tập con của danh sách
   * toạ độ gửi lên. Nhờ vậy mỗi request vẫn gửi tối đa `limit` toạ độ nhưng lấy
   * được đúng một ô chữ nhật của ma trận, rồi dán các ô lại thành ma trận đầy đủ.
   *
   * Số request = ceil(n/half)² với half = limit/2. Với n = 40, limit = 25 thì
   * half = 12 -> 4×4 = 16 request. Tăng nhanh theo n² nên màn hình lập kế hoạch
   * phải giới hạn số điểm mỗi lần tối ưu.
   */
  private async fetchTiled(points: readonly LatLng[], limit: number): Promise<CostMatrix> {
    const n = points.length;
    const half = Math.max(2, Math.floor(limit / 2));

    const distances = this.zeros(n);
    const durations = this.zeros(n);
    let real = true;

    for (let i = 0; i < n; i += half) {
      for (let j = 0; j < n; j += half) {
        const rows = points.slice(i, i + half);
        const cols = points.slice(j, j + half);

        const block = await this.fetchBlock(rows, cols);
        real &&= block.real;

        for (let r = 0; r < rows.length; r++) {
          for (let c = 0; c < cols.length; c++) {
            distances[i + r][j + c] = block.distances[r][c];
            durations[i + r][j + c] = block.durations[r][c];
          }
        }

        if (this.config.osrmThrottleMs > 0) await this.delay(this.config.osrmThrottleMs);
      }
    }

    return { distances, durations, real };
  }

  /** Một ô chữ nhật của ma trận: `sources` (hàng) × `destinations` (cột). */
  private async fetchBlock(
    sources: readonly LatLng[],
    destinations: readonly LatLng[],
  ): Promise<CostMatrix> {
    // Gộp hai tập vào một chuỗi toạ độ, rồi trỏ chỉ số — đúng cách OSRM yêu cầu.
    const all = [...sources, ...destinations];
    const coords = all.map((p) => `${p.lng},${p.lat}`).join(';');

    const sourceIdx = sources.map((_, i) => i).join(';');
    const destIdx = destinations.map((_, i) => sources.length + i).join(';');

    const url =
      `${this.config.osrmHost}/table/v1/driving/${coords}` +
      `?annotations=duration,distance&sources=${sourceIdx}&destinations=${destIdx}`;

    const res = await firstValueFrom(this.http.get<OsrmTableResponse>(url));
    if (res.code !== 'Ok' || !res.durations) throw new Error(`OSRM table: ${res.code}`);

    // `null` = không có đường nối (đảo, khu vực tách rời). Thay bằng ước lượng
    // chim bay ×1.4 chứ KHÔNG để Infinity: Infinity lan vào thuật toán tối ưu
    // làm mọi phép so sánh thành NaN và lời giải ra thứ tự ngẫu nhiên.
    const fix = (value: number | null, a: LatLng, b: LatLng, asDuration: boolean): number => {
      if (value != null && Number.isFinite(value)) return value;
      const meters = distanceMeters(a, b) * 1.4;
      return asDuration ? meters / ((24 * 1000) / 3600) : meters;
    };

    return {
      real: true,
      durations: res.durations.map((row, r) =>
        row.map((v, c) => fix(v, sources[r], destinations[c], true)),
      ),
      distances: (res.distances ?? res.durations).map((row, r) =>
        row.map((v, c) => fix(v, sources[r], destinations[c], false)),
      ),
    };
  }

  /**
   * Dự phòng khi không gọi được server: Haversine × 1.4.
   *
   * Hệ số 1.4 là "circuity factor" — tỉ lệ thực nghiệm giữa quãng đường đi thật
   * theo phố và đường chim bay ở đô thị dạng lưới. Không nhân hệ số thì mọi
   * quãng đường đều bị báo thiếu ~30%, giờ dự kiến tới nơi sai hàng loạt.
   */
  private haversineMatrix(points: readonly LatLng[]): CostMatrix {
    const n = points.length;
    const distances = this.zeros(n);
    const durations = this.zeros(n);
    const speedMs = (24 * 1000) / 3600;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const meters = distanceMeters(points[i], points[j]) * 1.4;
        distances[i][j] = meters;
        durations[i][j] = meters / speedMs;
      }
    }

    return { distances, durations, real: false };
  }

  private zeros(n: number): number[][] {
    return Array.from({ length: n }, () => new Array<number>(n).fill(0));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
