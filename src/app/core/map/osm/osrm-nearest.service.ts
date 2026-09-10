import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng } from '../map.types';

interface OsrmWaypoint {
  /** [lng, lat] của điểm đã bám vào đường. */
  location: [number, number];
  /** Khoảng cách từ toạ độ gửi lên tới đường gần nhất (mét). */
  distance: number;
  name: string;
}

interface OsrmNearestResponse {
  code: string;
  waypoints?: OsrmWaypoint[];
}

/** Kết quả bám đường của MỘT điểm. */
export interface SnapResult {
  /** Toạ độ gốc người dùng chọn. */
  original: LatLng;
  /** Toạ độ đã bám vào tim đường gần nhất. */
  snapped: LatLng;
  /** Người dùng bấm lệch khỏi đường bao nhiêu mét. */
  offsetMeters: number;
  /** Tên đường bám vào — rỗng với ngõ/ngách không tên trong OSM. */
  roadName: string;
  /** `false` khi không bám được (ngoài vùng phủ dữ liệu, mất mạng...). */
  matched: boolean;
}

/**
 * ============ BÁM ĐIỂM VÀO ĐƯỜNG — OSRM `/nearest/v1` ============
 *
 * VẤN ĐỀ NÓ GIẢI QUYẾT (đúng phần "sai số trên map nhỏ thôi"):
 *
 * Người dùng bấm lên bản đồ để chọn điểm giao thì gần như KHÔNG BAO GIỜ bấm
 * trúng tim đường — họ bấm vào mái nhà, vào sân, vào giữa ô phố. Nếu lấy nguyên
 * toạ độ đó đem đi định tuyến thì:
 *
 *  1. Máy chủ định tuyến tự bám vào đường gần nhất theo cách của nó, và **không
 *     nói cho ta biết nó bám vào đâu** -> đường vẽ ra bắt đầu/kết thúc ở một chỗ
 *     lệch với cái pin đang hiển thị. Nhìn như bug "đường không nối tới marker".
 *  2. Toà nhà nằm giữa hai con phố song song thì máy chủ có thể chọn nhầm phố ở
 *     mặt sau, khiến cả tuyến vòng thêm cả cây số mà không ai hiểu vì sao.
 *  3. Khoảng cách tính ra sai lệch đúng bằng phần "bấm hụt" đó, cộng dồn qua
 *     hàng chục điểm giao thành sai số lớn.
 *
 * Gọi `/nearest` trước là ta CHỦ ĐỘNG biết điểm thật sự nằm ở đâu trên mạng
 * đường, hiển thị luôn cho người dùng thấy "đã dịch pin 23 m vào Trần Duy Hưng",
 * và mọi con số phía sau đều tính trên cùng một toạ độ.
 *
 * Đây chính là thứ Google Maps làm ngầm khi ta thả ghim: ghim tự nhảy ra mép đường.
 */
@Injectable({ providedIn: 'root' })
export class OsrmNearestService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /**
   * Bám một điểm vào mạng đường.
   *
   * KHÔNG BAO GIỜ NÉM LỖI: mất mạng hay OSRM chết thì trả về chính điểm gốc với
   * `matched: false`. Bám đường là tính năng *làm đẹp số liệu*, không được phép
   * chặn thao tác thêm điểm của người dùng.
   *
   * @param radiusMeters bán kính tìm kiếm. Để rộng quá thì điểm trong ngõ sâu bị
   *        kéo ra đường lớn cách 200 m; để hẹp quá thì không tìm ra đường nào.
   *        50 m là mức hợp lý cho đô thị VN.
   */
  async snap(point: LatLng, radiusMeters = 50): Promise<SnapResult> {
    const fallback: SnapResult = {
      original: point,
      snapped: point,
      offsetMeters: 0,
      roadName: '',
      matched: false,
    };

    try {
      const url =
        `${this.config.osrmHost}/nearest/v1/driving/${point.lng},${point.lat}` +
        `?number=1&radiuses=${radiusMeters}`;

      const res = await firstValueFrom(this.http.get<OsrmNearestResponse>(url));
      const wp = res.waypoints?.[0];
      if (res.code !== 'Ok' || !wp) return fallback;

      const [lng, lat] = wp.location;
      return {
        original: point,
        snapped: { lat, lng },
        offsetMeters: Math.round(wp.distance),
        roadName: wp.name ?? '',
        matched: true,
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Bám nhiều điểm.
   *
   * OSRM `/nearest` chỉ nhận **một** toạ độ mỗi lần gọi (khác `/table` hay
   * `/route` nhận cả chuỗi) — nên n điểm là n request. Chạy TUẦN TỰ có giãn cách
   * thay vì `Promise.all`: bắn 30 request đồng thời vào server demo công cộng là
   * cách nhanh nhất để bị chặn IP.
   */
  async snapMany(points: readonly LatLng[], radiusMeters = 50): Promise<SnapResult[]> {
    const results: SnapResult[] = [];

    for (const point of points) {
      results.push(await this.snap(point, radiusMeters));
      if (this.config.osrmThrottleMs > 0) await this.delay(this.config.osrmThrottleMs);
    }

    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
