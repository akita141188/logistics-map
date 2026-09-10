import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng } from '../map.types';
import { distanceMeters } from '../geo.util';
import { CostMatrix } from '../osm/osrm-matrix.service';

const MATRIX_API = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/** Một ô của ma trận theo cách Google trả về (KHÔNG theo thứ tự gửi lên). */
interface MatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  distanceMeters?: number;
  /** Dạng chuỗi `"1234s"`. */
  duration?: string;
  condition?: 'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND';
}

/**
 * ====== MA TRẬN KHOẢNG CÁCH BẰNG GOOGLE — `distanceMatrix/v2:computeRouteMatrix` ======
 *
 * VÌ SAO TỒN TẠI SONG SONG VỚI `OsrmMatrixService`:
 * Ma trận là đầu vào bắt buộc của bài toán chia tuyến (`/planning`). Nếu nó chỉ
 * chạy được bằng OSRM thì ở những mạng chặn `router.project-osrm.org` — khá phổ
 * biến trong doanh nghiệp Việt Nam — màn lập kế hoạch âm thầm tụt xuống ước
 * lượng đường chim bay, ra một phương án chia tuyến trông vẫn hợp lý nhưng sai
 * 15–30% quãng đường. Người dùng không có cách nào biết.
 *
 * BA KHÁC BIỆT SO VỚI OSRM `/table` — không xử lý là ra ma trận sai lệch âm thầm:
 *
 *  1. **Kết quả trả về KHÔNG theo thứ tự.** Google trả một mảng phẳng các ô, mỗi
 *     ô tự khai `originIndex`/`destinationIndex`. Đọc tuần tự theo thứ tự mảng là
 *     xáo trộn toàn bộ ma trận.
 *  2. **Ô đường chéo (i→i) không có `distanceMeters`.** Trường bị lược khi giá
 *     trị bằng 0 — đặc tính của proto3, không phải lỗi.
 *  3. **Giới hạn theo SỐ Ô, không theo số điểm**: 625 ô với `TRAFFIC_UNAWARE`,
 *     chỉ 100 ô nếu bật `TRAFFIC_AWARE`. Lập kế hoạch là tác vụ chạy theo lô cho
 *     ngày mai nên dùng `TRAFFIC_UNAWARE`: vừa được nhiều ô hơn 6 lần, vừa rẻ
 *     hơn, và tình trạng giao thông lúc bấm nút cũng chẳng nói lên điều gì về
 *     lúc xe thật sự lăn bánh.
 */
@Injectable({ providedIn: 'root' })
export class GoogleMatrixService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /** Cạnh tối đa của một khối: 25 × 25 = 625 ô, đúng trần của TRAFFIC_UNAWARE. */
  private static readonly BLOCK = 25;

  /** Không ném lỗi — hỏng thì trả ước lượng chim bay với `real: false`. */
  async getMatrix(points: readonly LatLng[]): Promise<CostMatrix> {
    const n = points.length;
    if (n < 2) return { distances: [[0]], durations: [[0]], real: false };

    try {
      const distances = this.zeros(n);
      const durations = this.zeros(n);
      const block = GoogleMatrixService.BLOCK;

      for (let i = 0; i < n; i += block) {
        for (let j = 0; j < n; j += block) {
          const rows = points.slice(i, i + block);
          const cols = points.slice(j, j + block);
          const cells = await this.fetchBlock(rows, cols);

          for (const cell of cells) {
            const r = cell.originIndex ?? 0;
            const c = cell.destinationIndex ?? 0;
            if (r >= rows.length || c >= cols.length) continue;

            // `ROUTE_NOT_FOUND` (đảo, khu tách rời) -> ước lượng thay vì Infinity:
            // Infinity lan vào thuật toán tối ưu là mọi so sánh thành NaN.
            const missing = cell.condition === 'ROUTE_NOT_FOUND';
            const fallbackMeters = distanceMeters(rows[r], cols[c]) * 1.4;

            distances[i + r][j + c] = missing
              ? fallbackMeters
              : (cell.distanceMeters ?? (r === c && i === j ? 0 : fallbackMeters));

            durations[i + r][j + c] = missing
              ? fallbackMeters / ((24 * 1000) / 3600)
              : Number.parseFloat(cell.duration ?? '0');
          }
        }
      }

      return { distances, durations, real: true };
    } catch {
      return this.haversineMatrix(points);
    }
  }

  private async fetchBlock(
    origins: readonly LatLng[],
    destinations: readonly LatLng[],
  ): Promise<MatrixElement[]> {
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': this.config.googleMapsKey,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,duration,condition',
    });

    const body = {
      origins: origins.map((p) => this.toWaypoint(p)),
      destinations: destinations.map((p) => this.toWaypoint(p)),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
    };

    const res = await firstValueFrom(
      this.http.post<MatrixElement[]>(MATRIX_API, body, { headers }),
    );

    if (!Array.isArray(res)) throw new Error('computeRouteMatrix: response không phải mảng');
    return res;
  }

  private toWaypoint({ lat, lng }: LatLng) {
    return { waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } };
  }

  /** Xem chú thích hệ số 1.4 ở `OsrmMatrixService.haversineMatrix`. */
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
}
