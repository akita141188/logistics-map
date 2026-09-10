import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng } from '../map.types';
import { decimatePoints, distanceMeters } from '../geo.util';

interface OsrmTracepoint {
  /** [lng, lat] vị trí đã bám vào đường của điểm GPS tương ứng. */
  location: [number, number];
  /** Khoảng cách từ điểm GPS thô tới vị trí bám (mét). */
  distance: number;
  name?: string;
  matchings_index?: number;
  waypoint_index?: number;
}

interface OsrmMatching {
  confidence: number;
  distance: number;
  duration: number;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

interface OsrmMatchResponse {
  code: string;
  message?: string;
  /** Cùng độ dài với danh sách toạ độ gửi lên; `null` = không bám được điểm đó. */
  tracepoints?: (OsrmTracepoint | null)[];
  matchings?: OsrmMatching[];
}

export interface MatchOptions {
  /**
   * Bán kính tìm đường quanh mỗi điểm GPS (mét). Chính là "sai số cho phép của
   * thiết bị". Điện thoại đời mới ngoài trời sai ~10 m, trong phố nhiều nhà cao
   * tầng có thể 30–50 m. Để hẹp -> nhiều điểm không bám được; để rộng -> dễ bám
   * nhầm sang con phố song song bên cạnh.
   */
  radiusMeters?: number;
  /** Giảm số điểm đầu vào trước khi khớp (mỗi 10 điểm là 1 request). */
  maxPoints?: number;
  /** Báo tiến độ để màn hình vẽ thanh chạy — khớp cả track mất vài giây. */
  onProgress?: (done: number, total: number) => void;
}

export interface MatchResult {
  /** Hình học đã bám đường, khâu liền từ các cửa sổ con. */
  path: LatLng[];
  /** Vị trí bám của từng điểm đầu vào (sau khi lấy mẫu thưa). `null` = không bám được. */
  snapped: (LatLng | null)[];
  /** Danh sách điểm đầu vào thực sự đem đi khớp (sau lấy mẫu thưa). */
  source: LatLng[];
  /** Độ tin cậy trung bình của OSRM (0..1). Dưới ~0.3 là kết quả đáng ngờ. */
  confidence: number;
  /** Tỉ lệ điểm bám được (0..1). */
  matchedRatio: number;
  /** SAI SỐ GPS trung bình: điểm thô cách tim đường bao nhiêu mét. */
  avgOffsetMeters: number;
  maxOffsetMeters: number;
  chunks: number;
  failedChunks: number;
}

/**
 * ================= KHỚP ĐƯỜNG (MAP MATCHING) — OSRM `/match/v1` =================
 *
 * ĐÂY LÀ TÍNH NĂNG TRẢ LỜI TRỰC TIẾP YÊU CẦU "SAI SỐ TRÊN MAP NHỎ THÔI".
 *
 * VẤN ĐỀ: GPS của điện thoại tài xế luôn nhiễu. Vẽ thẳng chuỗi toạ độ thô lên
 * bản đồ thì được một đường răng cưa chạy đè lên mái nhà, cắt ngang công viên,
 * nhảy qua nhảy lại giữa hai chiều đường. Hậu quả không chỉ xấu:
 *
 *  - **Quãng đường thực tế bị thổi phồng**: mỗi lần răng cưa là cộng thêm vài
 *    mét; nhân với hàng trăm điểm thành sai lệch vài km mỗi chuyến. Nếu doanh
 *    nghiệp tính lương/nhiên liệu theo số km này thì sai số đó là tiền thật.
 *  - **Cảnh báo lệch tuyến báo bừa**: nhiễu đẩy điểm ra xa lộ trình dự kiến quá
 *    ngưỡng, hệ thống la làng dù tài xế đi đúng đường.
 *  - **Không biết xe đi phố nào**: toạ độ thô không gắn với con đường nào cả.
 *
 * CÁCH GIẢI: thuật toán Map Matching của OSRM dùng **mô hình Markov ẩn (HMM)**
 * theo bài báo Newson & Krumm (2009). Mỗi điểm GPS có nhiều "ứng viên" là các
 * đoạn đường quanh nó; thuật toán chọn chuỗi ứng viên vừa gần điểm đo vừa nối
 * được với nhau bằng quãng đường hợp lý. Kết quả là đường đi bám đúng tim phố.
 *
 * ────────────────── RÀNG BUỘC THẬT CỦA SERVER CÔNG CỘNG ──────────────────
 *
 * `router.project-osrm.org` chặn `/match` ở **10 toạ độ mỗi request**
 * (đo trực tiếp: 10 điểm OK, 11 điểm trả `400 {"code":"TooBig"}`).
 * Một GPS track thật có hàng trăm điểm. Nên service này:
 *
 *   1. Lấy mẫu thưa track xuống `maxPoints` (mặc định 120).
 *   2. Cắt thành các cửa sổ 10 điểm, **chồng mép 1 điểm**: cửa sổ sau bắt đầu
 *      đúng tại điểm cuối của cửa sổ trước. Không chồng mép thì giữa hai cửa sổ
 *      hở một khoảng trắng, đường vẽ ra bị đứt khúc.
 *   3. Gọi tuần tự, có giãn cách, báo tiến độ.
 *   4. Cửa sổ nào khớp hỏng (`NoMatch`, `NoSegment`) thì **giữ nguyên đoạn GPS
 *      thô** của cửa sổ đó, không vứt dữ liệu đi.
 *   5. Khâu hình học các cửa sổ, bỏ điểm trùng ở chỗ nối.
 *
 * Self-host thì đặt `osrm-routed --max-matching-size 1000` là gọi một phát xong.
 */
@Injectable({ providedIn: 'root' })
export class OsrmMatchService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  async matchTrack(points: readonly LatLng[], options: MatchOptions = {}): Promise<MatchResult> {
    const radius = options.radiusMeters ?? 25;
    const source = decimatePoints(points, options.maxPoints ?? 120);

    if (source.length < 2) {
      return this.emptyResult(source);
    }

    const windowSize = Math.max(2, this.config.osrmMaxMatchPoints);
    // Bước nhảy = windowSize - 1 để cửa sổ sau dùng lại điểm cuối của cửa sổ trước.
    const stride = windowSize - 1;
    const totalChunks = Math.max(1, Math.ceil((source.length - 1) / stride));

    const path: LatLng[] = [];
    const snapped: (LatLng | null)[] = new Array(source.length).fill(null);
    const offsets: number[] = [];
    const confidences: number[] = [];

    let failedChunks = 0;
    let chunkIndex = 0;

    for (let start = 0; start < source.length - 1; start += stride) {
      const end = Math.min(start + windowSize, source.length);
      const chunk = source.slice(start, end);

      const matched = await this.matchChunk(chunk, radius);

      if (matched) {
        this.appendPath(path, matched.geometry);
        confidences.push(matched.confidence);

        matched.tracepoints.forEach((tp, i) => {
          if (!tp) return;
          const [lng, lat] = tp.location;
          snapped[start + i] = { lat, lng };
          offsets.push(tp.distance);
        });
      } else {
        failedChunks++;
        // Khớp hỏng -> dùng nguyên đoạn thô. Thà đường hơi răng cưa ở một khúc
        // còn hơn để thủng một lỗ trên lộ trình.
        this.appendPath(path, chunk);
      }

      options.onProgress?.(++chunkIndex, totalChunks);

      if (this.config.osrmThrottleMs > 0) await this.delay(this.config.osrmThrottleMs);
    }

    const matchedCount = snapped.filter(Boolean).length;

    return {
      path,
      snapped,
      source,
      confidence: confidences.length ? this.average(confidences) : 0,
      matchedRatio: source.length ? matchedCount / source.length : 0,
      avgOffsetMeters: offsets.length ? this.average(offsets) : 0,
      maxOffsetMeters: offsets.length ? Math.max(...offsets) : 0,
      chunks: totalChunks,
      failedChunks,
    };
  }

  /**
   * Khớp MỘT cửa sổ. Trả `null` khi hỏng — người gọi tự xử lý bằng dữ liệu thô.
   *
   * `radiuses` phải có đúng số phần tử bằng số toạ độ, nếu không OSRM trả
   * `InvalidOptions`. Đây là lỗi hay dính nhất khi tự ghép URL cho `/match`.
   */
  private async matchChunk(
    chunk: readonly LatLng[],
    radius: number,
  ): Promise<{
    geometry: LatLng[];
    tracepoints: (OsrmTracepoint | null)[];
    confidence: number;
  } | null> {
    try {
      const coords = chunk.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const radiuses = chunk.map(() => radius).join(';');

      const url =
        `${this.config.osrmHost}/match/v1/driving/${coords}` +
        `?geometries=geojson&overview=full&radiuses=${radiuses}&gaps=ignore&tidy=false`;

      const res = await firstValueFrom(this.http.get<OsrmMatchResponse>(url));
      if (res.code !== 'Ok' || !res.matchings?.length) return null;

      // `gaps=ignore` thường cho đúng 1 matching, nhưng vẫn nối phòng trường hợp
      // OSRM cắt thành nhiều mảnh khi track có khoảng trống lớn.
      const geometry: LatLng[] = [];
      for (const m of res.matchings) {
        this.appendPath(
          geometry,
          m.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        );
      }

      return {
        geometry,
        tracepoints: res.tracepoints ?? [],
        confidence: this.average(res.matchings.map((m) => m.confidence)),
      };
    } catch {
      return null;
    }
  }

  /** Nối thêm đoạn vào đường, bỏ điểm đầu nếu trùng điểm cuối hiện có (< 1 m). */
  private appendPath(target: LatLng[], segment: readonly LatLng[]): void {
    if (!segment.length) return;

    const last = target[target.length - 1];
    const start = last && distanceMeters(last, segment[0]) < 1 ? 1 : 0;

    for (let i = start; i < segment.length; i++) target.push(segment[i]);
  }

  private average(values: readonly number[]): number {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private emptyResult(source: LatLng[]): MatchResult {
    return {
      path: [...source],
      snapped: source.map(() => null),
      source,
      confidence: 0,
      matchedRatio: 0,
      avgOffsetMeters: 0,
      maxOffsetMeters: 0,
      chunks: 0,
      failedChunks: 0,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
