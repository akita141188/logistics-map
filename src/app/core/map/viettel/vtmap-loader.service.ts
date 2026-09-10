import { DOCUMENT, Injectable, inject } from '@angular/core';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { Vtmapgl } from './vtmap.types';

/**
 * Nạp SDK `vtmap-gl.js` từ CDN Viettel và chờ `window.vtmapgl` sẵn sàng.
 *
 * Port của `loadMapResource()` + `waitForVtmapgl()` trong `viettel-map.js`.
 *
 * Cải tiến so với bản Vue:
 *  - Bản Vue dùng biến `loaded = 0/1` và callback: gọi 2 lần cùng lúc (2 component
 *    cùng mount) thì lần thứ 2 chạy callback NGAY trong khi script chưa onload
 *    -> `vtmapgl is not defined`. Ở đây cache đúng 1 Promise duy nhất.
 *  - Có timeout để không treo vô hạn khi mạng chặn CDN.
 *  - Không dùng vòng lặp `setTimeout(check, 100)` (polling) nữa.
 */
@Injectable({ providedIn: 'root' })
export class VtmapLoaderService {
  private readonly document = inject(DOCUMENT);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  private static readonly TIMEOUT_MS = 15_000;
  private loading?: Promise<Vtmapgl>;

  /** Idempotent: gọi bao nhiêu lần cũng chỉ chèn script 1 lần. */
  load(): Promise<Vtmapgl> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  /** Đã sẵn sàng chưa — dùng cho guard đồng bộ, không await được. */
  get instance(): Vtmapgl | undefined {
    return this.document.defaultView?.vtmapgl;
  }

  private doLoad(): Promise<Vtmapgl> {
    const win = this.document.defaultView;

    if (win?.vtmapgl) {
      this.applyToken(win.vtmapgl);
      return Promise.resolve(win.vtmapgl);
    }

    const { vtmapDomain, vtmapVersion } = this.config;
    const base = `https://${vtmapDomain}/files/sdk/vtmap-gl-js/${vtmapVersion}`;

    return new Promise<Vtmapgl>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Reset để lần mở màn sau còn thử lại được.
        this.loading = undefined;
        reject(new Error(`vtmapgl SDK không phản hồi sau ${VtmapLoaderService.TIMEOUT_MS}ms`));
      }, VtmapLoaderService.TIMEOUT_MS);

      const head = this.document.head;

      if (!this.document.querySelector('link[data-vtmap-css]')) {
        const css = this.document.createElement('link');
        css.rel = 'stylesheet';
        css.href = `${base}/vtmap-gl.css`;
        css.dataset['vtmapCss'] = '1';
        head.appendChild(css);
      }

      const existing = this.document.querySelector<HTMLScriptElement>(
        'script[data-vtmap-sdk]',
      );
      const script = existing ?? this.document.createElement('script');

      script.onload = () => {
        clearTimeout(timer);
        const sdk = this.document.defaultView?.vtmapgl;
        if (!sdk) {
          this.loading = undefined;
          reject(new Error('Script vtmap-gl.js đã tải nhưng không tìm thấy window.vtmapgl'));
          return;
        }
        this.applyToken(sdk);
        resolve(sdk);
      };

      script.onerror = () => {
        clearTimeout(timer);
        this.loading = undefined;
        reject(new Error(`Không tải được ${base}/vtmap-gl.js`));
      };

      if (!existing) {
        script.type = 'text/javascript';
        script.src = `${base}/vtmap-gl.js`;
        script.dataset['vtmapSdk'] = '1';
        head.appendChild(script);
      }
    });
  }

  private applyToken(sdk: Vtmapgl): void {
    // Access token là biến TĨNH của SDK, phải set trước mọi lệnh khởi tạo Map/Control.
    sdk.accessToken = this.config.vtmapKey;
  }
}
