import { Injectable, inject } from '@angular/core';
import { RoutePoint } from '../map.types';
import { formatDateTime, formatTimeLabel } from '../geo.util';
import { escapeHtml, safeGeoLink } from '../html-safe.util';
import { ViettelMapService } from './viettel-map.service';
import { ROAD_MARKER_CLASS, VtPopup } from './vtmap.types';

const STYLE_ELEMENT_ID = 'custom-road-style';
const CUSTOM_MARKER_CLASS = 'custom-road-marker';
const HIDDEN_MARKER_CLASS = 'custom-road-marker--hidden';

/**
 * Trang trí lại các marker số thứ tự mà `RoadDrawerControl` tự sinh ra, và gắn
 * popup thông tin cho từng điểm GPS.
 *
 * Vì sao phải "hack DOM" thay vì dùng API: SDK tự render marker với class
 * `.indexed-marker` và KHÔNG expose handle nào để tuỳ biến. Cách duy nhất là
 * quét DOM sau khi routing xong rồi ghi đè nội dung.
 *
 * 2 tối ưu bắt buộc phải giữ:
 *  1. EVENT DELEGATION — 1 listener trên container thay vì N listener cho N marker.
 *  2. DECIMATION — ẩn bớt marker bằng CSS class, tuyệt đối không xoá node
 *     (xoá node là SDK vẽ lại lần sau sẽ lệch index).
 */
@Injectable()
export class RoadMarkerRenderer {
  private readonly mapService = inject(ViettelMapService);

  private popup: VtPopup | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;

  /** Nội suy i18n — inject TranslateService/`$localize` thật ở app của bạn. */
  private translate: (key: string, fallback: string) => string = (_k, f) => f;

  useTranslator(fn: (key: string, fallback: string) => string): void {
    this.translate = fn;
  }

  /**
   * @param points   danh sách điểm ĐÃ dedupe/decimate — index phải khớp 1-1 với
   *                 thứ tự marker mà SDK sinh ra.
   * @param visible  tập index được phép hiển thị.
   */
  render(points: readonly RoutePoint[], visible: ReadonlySet<number>): void {
    const map = this.mapService.instance;
    if (!map) return;

    this.injectStyleOnce();

    const markerEls = Array.from(
      document.getElementsByClassName(ROAD_MARKER_CLASS),
    ) as HTMLElement[];
    if (!markerEls.length) return;

    markerEls.forEach((el, i) => {
      const point = points[i];
      if (!point) return;

      el.classList.add(CUSTOM_MARKER_CLASS);
      el.classList.toggle(HIDDEN_MARKER_CLASS, !visible.has(i));
      if (!visible.has(i)) return;

      const label = this.buildLabel(point, i);
      // `staffTitle`/`deviceId` là dữ liệu server -> escape (xem `html-safe.util.ts`).
      el.innerHTML = `<span>${escapeHtml(label)}</span>`;
      el.dataset['pointIdx'] = String(i);
      el.dataset['pointLabel'] = label;
      // Xoá handler inline của lần render trước (nếu có) — tránh double popup.
      el.onclick = null;
    });

    this.attachDelegatedClick(points);
  }

  /** Gọi TRƯỚC mỗi lần vẽ mới và trong `ngOnDestroy`. */
  cleanup(): void {
    this.popup?.remove();
    this.popup = null;

    const container = this.mapService.instance?.getContainer();
    if (container && this.clickHandler) {
      container.removeEventListener('click', this.clickHandler);
    }
    this.clickHandler = null;
  }

  /** Nhãn ưu tiên: `HH:mm` -> staffTitle -> deviceId -> `#index`. */
  private buildLabel(point: RoutePoint, index: number): string {
    const time = formatTimeLabel(
      point.createDate ?? point.createdAt ?? point.create_date,
    );
    return time || point.staffTitle || point.deviceId || `#${index + 1}`;
  }

  private attachDelegatedClick(points: readonly RoutePoint[]): void {
    const map = this.mapService.instance;
    if (!map) return;

    const container = map.getContainer();
    if (this.clickHandler) {
      container.removeEventListener('click', this.clickHandler);
    }

    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const el = target?.closest<HTMLElement>(`.${CUSTOM_MARKER_CLASS}`);
      if (!el || !container.contains(el)) return;

      const idx = Number(el.dataset['pointIdx']);
      const point = Number.isNaN(idx) ? undefined : points[idx];
      if (!point) return;

      event.stopPropagation();

      this.popup?.remove();
      const sdk = this.mapService.vtmapgl;
      if (!sdk) return;

      this.popup = new sdk.Popup({
        closeOnClick: true,
        offset: 10,
        className: 'road-popup',
      })
        .setLngLat([point.lng, point.lat])
        .setHTML(this.buildPopupHtml(point, el.dataset['pointLabel'] ?? ''))
        .addTo(map);
    };

    container.addEventListener('click', handler);
    this.clickHandler = handler;
  }

  /**
   * Popup của 1 điểm GPS: thời điểm ghi log, % pin, và link mở Google Maps.
   * Đây chính là chỗ "chỉ đường thật" được delegate sang app Google.
   */
  private buildPopupHtml(point: RoutePoint, label: string): string {
    const created = formatDateTime(
      point.createDate ?? point.createdAt ?? point.create_date,
    );
    const battery =
      point.battery != null ? `${point.battery}%` : (point.batteryPercent ?? '');
    const mapUrl = safeGeoLink(point.lat, point.lng);
    const title = escapeHtml(created || point.staffTitle || label);

    return `
      <div class="road-popup__content">
        <div class="road-popup__title">${title}</div>
        ${
          battery
            ? `<div class="road-popup__line">${escapeHtml(this.translate('routes.routeMgm.batteryPercent', 'Pin'))}: ${escapeHtml(battery)}</div>`
            : ''
        }
        ${
          mapUrl
            ? `<a class="road-popup__line view-on-google-map" target="_blank" rel="noopener noreferrer" href="${mapUrl}">
          ${escapeHtml(this.translate('routes.routeMgm.locationInGoogleMap', 'Xem trên Google Maps'))}
        </a>`
            : ''
        }
      </div>
    `;
  }

  /**
   * CSS phải inject vào `document.head`, KHÔNG để trong `styles` của component:
   * marker do SDK tạo nằm ngoài cây view của Angular nên view-encapsulation
   * (`_ngcontent-*`) sẽ không áp được. Cách khác là để `encapsulation: None`
   * nhưng như vậy CSS rò rỉ ra toàn app.
   */
  private injectStyleOnce(): void {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = `
      .road-popup.vtmapgl-popup,
      .road-popup.mapboxgl-popup {
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      }
      .road-popup .vtmapgl-popup-content,
      .road-popup .mapboxgl-popup-content {
        padding: 10px 12px;
        border-radius: 10px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
        min-width: 160px;
      }
      .road-popup .vtmapgl-popup-close-button,
      .road-popup .mapboxgl-popup-close-button {
        font-size: 14px; top: 4px; right: 6px; color: #555;
      }
      .road-popup__title { font-weight: 600; margin-bottom: 6px; font-size: 13px; }
      .road-popup__line { font-size: 12px; color: #333; line-height: 1.3; margin-bottom: 4px; }
      .view-on-google-map { font-weight: 600; color: #42a5e3; text-decoration: none; }
      .view-on-google-map:hover { text-decoration: underline; }

      .${ROAD_MARKER_CLASS}.${CUSTOM_MARKER_CLASS} {
        background: #d7d7d7;
        color: #000;
        border-radius: 9999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 12px;
        border: 2px solid #fff;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
        cursor: pointer;
        min-width: 36px;
        height: 28px;
        padding: 0 8px;
        white-space: nowrap;
        transition: transform 0.12s ease;
      }
      .${ROAD_MARKER_CLASS}.${CUSTOM_MARKER_CLASS}:hover { transform: scale(1.06); }
      .${ROAD_MARKER_CLASS}.${HIDDEN_MARKER_CLASS} { display: none !important; }
    `;
    document.head.appendChild(style);
  }
}
