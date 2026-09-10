import { DOCUMENT, Injectable, inject } from '@angular/core';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';

/**
 * Nạp Google Maps JavaScript API bằng script động.
 *
 * Vì sao KHÔNG nhét thẳng `<script>` vào `index.html`:
 *  - API key nằm cứng trong HTML thì không đổi được theo môi trường build.
 *  - Người dùng chọn provider khác (Viettel/OSM) thì không cần tải SDK Google —
 *    tiết kiệm ~200KB và tránh bị tính lượt "map load" (Google tính tiền theo lượt).
 *
 * `loading=async` là tham số Google khuyến nghị từ 2023, thiếu nó console sẽ
 * cảnh báo "Google Maps JavaScript API has been loaded directly without loading=async".
 */
@Injectable({ providedIn: 'root' })
export class GoogleMapsLoaderService {
  private readonly document = inject(DOCUMENT);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  private loading?: Promise<void>;

  /** Idempotent: gọi bao nhiêu lần cũng chỉ chèn script 1 lần. */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private doLoad(): Promise<void> {
    if (!this.config.googleMapsKey) {
      return Promise.reject(
        new Error('Chưa cấu hình Google Maps API key (googleMapsKey trong app.config.ts).'),
      );
    }

    const win = this.document.defaultView as (Window & { google?: unknown }) | null;
    if (win?.google) return Promise.resolve();

    const params = new URLSearchParams({
      key: this.config.googleMapsKey,
      // `marker` cần cho <map-advanced-marker>, `geometry` cần cho encoding/spherical.
      libraries: 'marker,geometry',
      language: 'vi',
      region: 'VN',
      loading: 'async',
      v: 'weekly',
    });

    return new Promise<void>((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        this.loading = undefined;
        reject(new Error('Không tải được Google Maps JavaScript API (kiểm tra key/referrer).'));
      };
      this.document.head.appendChild(script);
    });
  }
}
