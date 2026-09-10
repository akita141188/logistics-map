import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';

/**
 * ⚠️ IMPORT SÂU CÓ CHỦ Ý — KHÔNG đổi thành `from './core/map'`.
 *
 * Barrel `core/map/index.ts` re-export cả `osm-map.component`, mà component đó
 * `import * as L from 'leaflet'`. Chạm vào barrel từ một file EAGER (app.config,
 * app.ts, main.ts) là kéo nguyên Leaflet (~150 kB) vào bundle khởi động, phá
 * sạch ý đồ `loadComponent` lazy của các màn bản đồ.
 *
 * Đây là cái bẫy kinh điển của barrel file: nó gom mọi thứ vào một điểm nên
 * bundler không tách được nữa. Đã đo: dùng barrel -> Leaflet nằm trong chunk
 * khởi động; import sâu -> Leaflet nằm trong chunk lazy dùng chung của 4 màn bản đồ.
 *
 * Các màn hình (đã lazy sẵn) thì vẫn import qua barrel cho gọn.
 */
import { MapProvider } from './core/map/map.types';
import { MapRuntimeKeys } from './core/map/runtime-keys';
import { provideMapRouting } from './core/map/map-routing.config';

/**
 * Dựng cấu hình app từ bộ key đọc được lúc runtime (xem `core/map/runtime-keys.ts`).
 *
 * Là hàm chứ không phải hằng số, vì key chỉ có sau khi `main.ts` fetch xong
 * `public/map-keys.json` — không thể biết lúc module này được đánh giá.
 */
export function createAppConfig(keys: MapRuntimeKeys): ApplicationConfig {
  /**
   * Provider mặc định chọn theo key đang có, không hard-code.
   *
   * Có key Google -> mở thẳng Google cho giống dự án DMS gốc (bên đó Google là
   * provider chính). Không key -> OpenStreetMap, để người mới clone về vẫn thấy
   * bản đồ chạy được ngay thay vì một thẻ báo lỗi.
   */
  const defaultProvider = keys.googleMapsKey ? MapProvider.Google : MapProvider.OpenStreet;

  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      provideRouter(routes, withComponentInputBinding()),

      provideMapRouting({
        defaultProvider,

        // Google Maps: key cần bật "Maps JavaScript API" + "Routes API" +
        // "Geocoding API", và PHẢI giới hạn theo HTTP referrer (key trong app
        // trình duyệt luôn lộ, referrer là lớp bảo vệ duy nhất).
        googleMapsKey: keys.googleMapsKey,
        // Map ID bắt buộc khi dùng Advanced Marker. Để trống hoặc 'DEMO_MAP_ID'
        // thì component tự bỏ qua, tránh Google chuyển sang vector mode rồi cảnh báo.
        googleMapId: keys.googleMapId,

        // Viettel Map: access token lấy tại https://maps.viettel.vn
        vtmapKey: keys.vtmapKey,

        // Đổi sang OSRM self-host khi lên production:
        // osrmBaseUrl: 'https://osrm.cong-ty-cua-ban.vn/route/v1',
      }),
    ],
  };
}
