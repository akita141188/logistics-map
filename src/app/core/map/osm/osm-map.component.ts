import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import {
  BASE_LAYERS,
  BaseLayerDef,
  DEFAULT_BASE_LAYER_ID,
  LatLng,
  MAP_COLORS,
  MapCircle,
  MapMarker,
  MapPath,
} from '../map.types';
import { distanceMeters, formatDistance } from '../geo.util';
import { escapeHtml, safeColor, safeGeoLink } from '../html-safe.util';

/**
 * =================== BẢN ĐỒ OPENSTREETMAP (Leaflet) ===================
 *
 * "Mặt bàn vẽ" mặc định của ứng dụng: chạy được ngay, không cần API key.
 *
 * Cài đặt:
 * ```bash
 * npm i leaflet && npm i -D @types/leaflet
 * ```
 * và thêm CSS vào `angular.json` (KHÔNG import trong component — CSS của Leaflet
 * nhắm vào các class `.leaflet-*` nằm ngoài cây view nên bị view-encapsulation chặn):
 * ```json
 * "styles": ["node_modules/leaflet/dist/leaflet.css", "src/styles.scss"]
 * ```
 *
 * BỐN ĐIỂM CẦN NHỚ:
 *  1. **THỨ TỰ TOẠ ĐỘ**: Leaflet dùng `[lat, lng]` — ngược với GeoJSON/OSRM.
 *  2. **SSR**: Leaflet đụng `window` ngay khi `L.map()` chạy, nên phải khởi tạo
 *     trong `afterNextRender()`, KHÔNG dùng `ngOnInit`.
 *  3. **Icon mặc định bị vỡ** khi bundle bằng esbuild/webpack (Leaflet tự dò
 *     đường dẫn ảnh marker). Ở đây dùng `L.divIcon` (HTML thuần) nên tránh hẳn
 *     vấn đề này và tuỳ biến được nhãn/màu.
 *  4. **`L.circle` nhận bán kính theo MÉT thật** (co giãn khi zoom), còn
 *     `L.circleMarker` nhận bán kính theo PIXEL (không đổi khi zoom). Geofence
 *     bắt buộc phải dùng `L.circle` — dùng nhầm thì vòng tròn 150 m trông y hệt
 *     nhau ở mọi mức zoom, tức là vô nghĩa.
 *
 * Component này còn gánh phần "xem đường" của một web bản đồ thật:
 * đổi lớp nền, thước tỉ lệ, toạ độ con trỏ, thước đo khoảng cách, và nút định vị.
 */
@Component({
  selector: 'dms-osm-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #mapHost
      class="osm-map"
      [class.osm-map--picking]="pickMode()"
      [class.osm-map--measuring]="measuring()"
    ></div>

    @if (pickMode()) {
      <div class="osm-map__hint">Bấm lên bản đồ để chọn vị trí</div>
    }

    <!-- ================= bộ điều khiển góc phải ================= -->
    <div class="osm-tools">
      <button
        type="button"
        class="osm-tools__btn"
        [class.active]="layerPanelOpen()"
        title="Lớp bản đồ nền"
        (click)="toggleLayerPanel()"
      >
        🗺️
      </button>
      <button
        type="button"
        class="osm-tools__btn"
        [class.active]="measuring()"
        title="Thước đo khoảng cách"
        (click)="toggleMeasure()"
      >
        📏
      </button>
      <button type="button" class="osm-tools__btn" title="Vị trí của tôi" (click)="locateMe()">
        🎯
      </button>
      <button type="button" class="osm-tools__btn" title="Thu gọn vừa khung" (click)="fitContent()">
        ⤢
      </button>
    </div>

    @if (layerPanelOpen()) {
      <div class="osm-layers">
        <div class="osm-layers__title">Lớp bản đồ nền</div>
        @for (layer of layers; track layer.id) {
          <button
            type="button"
            class="osm-layers__item"
            [class.active]="layer.id === baseLayerId()"
            (click)="selectLayer(layer.id)"
          >
            <strong>{{ layer.label }}</strong>
            <small>{{ layer.hint }}</small>
          </button>
        }
      </div>
    }

    @if (measuring()) {
      <div class="osm-measure">
        <div class="osm-measure__row">
          <span>Thước đo</span>
          <strong>{{ measureLabel() }}</strong>
        </div>
        <small>Bấm lên bản đồ để nối điểm · bấm lần nữa vào 📏 để tắt</small>
        <button type="button" (click)="clearMeasure()">Xoá</button>
      </div>
    }

    <!-- Toạ độ con trỏ: thứ mà mọi web bản đồ kỹ thuật đều có, để đối chiếu
         nhanh một vị trí với dữ liệu trong hệ thống. -->
    <div class="osm-readout">
      <span>{{ cursorText() }}</span>
      <span class="osm-readout__zoom">z{{ zoomLevel() }}</span>
    </div>
  `,
  styleUrl: './osm-map.component.scss',
})
export class OsmMapComponent {
  private readonly mapHost = viewChild.required<ElementRef<HTMLDivElement>>('mapHost');
  private readonly destroyRef = inject(DestroyRef);

  readonly center = input<LatLng>({ lat: 21.0278, lng: 105.8342 });
  readonly zoom = input(12);
  readonly markers = input<readonly MapMarker[]>([]);
  readonly paths = input<readonly MapPath[]>([]);
  readonly circles = input<readonly MapCircle[]>([]);
  /** Marker động (xe đang chạy khi playback) — vẽ riêng để không phải render lại cả cụm. */
  readonly vehicle = input<MapMarker | null>(null);
  /** Nhiều xe cùng lúc — màn điều hành đội xe. */
  readonly vehicles = input<readonly MapMarker[]>([]);
  /** Bật chế độ click-để-thêm-điểm. */
  readonly pickMode = input(false);
  /** Đổi giá trị này để ép bản đồ fit lại khung nhìn (vd sau khi tính xong tuyến). */
  readonly fitToken = input<string | number>(0);
  /**
   * Bay tới một điểm cụ thể. Dùng input (khai báo) thay vì gọi method qua
   * `viewChild` (mệnh lệnh) để màn hình cha không phải giữ tham chiếu component
   * bản đồ — nhờ vậy đổi provider không phải sửa gì ở màn hình.
   */
  readonly focus = input<LatLng | null>(null);

  readonly mapClick = output<LatLng>();
  readonly markerClick = output<MapMarker>();

  protected readonly layers = BASE_LAYERS;

  private map?: L.Map;
  private baseTile?: L.TileLayer;
  private overlayTile?: L.TileLayer;
  private markerLayer?: L.LayerGroup;
  private pathLayer?: L.LayerGroup;
  private circleLayer?: L.LayerGroup;
  private measureLayer?: L.LayerGroup;
  private vehicleMarker?: L.Marker;
  private readonly fleetMarkers = new Map<string, L.Marker>();

  /** Layer đường đang hiển thị, tra theo `MapPath.key` để cập nhật tại chỗ. */
  private readonly pathLayers = new Map<
    string,
    { layer: L.Polyline; points: readonly LatLng[]; style: string }
  >();
  private readonly initialized = signal(false);

  /** `fitToken` đã được thực hiện — xem effect fit ở constructor. */
  private appliedFitToken: string | number | null = null;

  // ------------------------------------------------------------ state điều khiển

  private static readonly LAYER_STORAGE_KEY = 'DMS_MAP_BASE_LAYER';

  protected readonly baseLayerId = signal<string>(this.restoreLayer());
  protected readonly layerPanelOpen = signal(false);
  protected readonly measuring = signal(false);
  protected readonly zoomLevel = signal(12);
  private readonly cursor = signal<LatLng | null>(null);
  private readonly measurePoints = signal<LatLng[]>([]);

  protected readonly cursorText = computed(() => {
    const c = this.cursor();
    return c ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : 'Di chuột lên bản đồ';
  });

  protected readonly measureLabel = computed(() => {
    const pts = this.measurePoints();
    if (pts.length < 2) return 'Chọn ít nhất 2 điểm';

    let total = 0;
    for (let i = 1; i < pts.length; i++) total += distanceMeters(pts[i - 1], pts[i]);

    return `${formatDistance(total)} · ${pts.length} điểm`;
  });

  constructor() {
    afterNextRender(() => this.initMap());

    effect(() => {
      const items = this.markers();
      if (this.initialized()) this.renderMarkers(items);
    });

    effect(() => {
      const items = this.paths();
      if (this.initialized()) this.renderPaths(items);
    });

    effect(() => {
      const items = this.circles();
      if (this.initialized()) this.renderCircles(items);
    });

    effect(() => {
      const v = this.vehicle();
      if (this.initialized()) this.renderVehicle(v);
    });

    effect(() => {
      const list = this.vehicles();
      if (this.initialized()) this.renderFleet(list);
    });

    effect(() => {
      const id = this.baseLayerId();
      if (this.initialized()) this.applyBaseLayer(id);
      localStorage.setItem(OsmMapComponent.LAYER_STORAGE_KEY, id);
    });

    effect(() => {
      const pts = this.measurePoints();
      if (this.initialized()) this.renderMeasure(pts);
    });

    /**
     * FIT ĐÚNG MỘT LẦN CHO MỖI `fitToken`, VÀ CHỜ CHO TỚI KHI CÓ DỮ LIỆU.
     *
     * Bản trước đọc `markers()`/`paths()` rồi fit ngay — hai lỗi cùng lúc:
     *
     *  1. **Fit rơi vào lúc chưa có gì để fit.** Đổi chuyến giao hàng là
     *     `resource` xoá dữ liệu về `undefined` trước khi tải xong, nên effect
     *     chạy với danh sách RỖNG: `fitContent()` thoát ngay ở nhánh
     *     `!coords.length`, và khi dữ liệu chuyến mới về thì token không còn đổi
     *     nữa -> bản đồ nằm lại ở khung nhìn của chuyến CŨ, người dùng phải tự
     *     tìm tuyến mới. Nay token được GHI NHỚ, chỉ đánh dấu là đã dùng khi
     *     thật sự fit được.
     *  2. **Fit lại mỗi nhịp dữ liệu.** Màn tua lại và màn dẫn đường đổi
     *     `paths()` mỗi 200–500 ms; effect cũ vì thế gọi `fitContent()` liên
     *     tục, giật khung nhìn và đè lên cả `flyTo` của chế độ bám xe. Nay dữ
     *     liệu đổi mà token không đổi thì KHÔNG fit.
     */
    effect(() => {
      const token = this.fitToken();
      const markers = this.markers();
      const paths = this.paths();
      const vehicles = this.vehicles();

      if (!this.initialized()) return;
      if (token === this.appliedFitToken) return;
      if (!this.collectCoords(markers, paths, vehicles).length) return;

      this.appliedFitToken = token;
      this.fitContent();
    });

    effect(() => {
      const point = this.focus();
      if (point && this.initialized()) this.flyTo(point);
    });

    this.destroyRef.onDestroy(() => {
      this.map?.remove();
      this.map = undefined;
    });
  }

  /** Bay tới một điểm — màn Chỉ đường gọi khi bấm vào một chỉ dẫn rẽ. */
  flyTo(point: LatLng, zoom = 17): void {
    this.map?.flyTo([point.lat, point.lng], zoom, { duration: 0.6 });
  }

  private initMap(): void {
    const c = this.center();

    this.map = L.map(this.mapHost().nativeElement, {
      center: [c.lat, c.lng],
      zoom: this.zoom(),
      zoomControl: true,
      zoomAnimation: true,
      // Nút thu phóng của Leaflet nằm góc trái trên; bộ công cụ riêng của app
      // nằm góc phải trên để không chồng lên nhau.
      attributionControl: true,
    });

    this.applyBaseLayer(this.baseLayerId());

    // Thước tỉ lệ: bắt buộc với bản đồ nghiệp vụ. Không có nó thì người xem
    // không ước lượng được "đoạn lệch này là 50 m hay 5 km".
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 140 }).addTo(this.map);

    this.pathLayer = L.layerGroup().addTo(this.map);
    this.circleLayer = L.layerGroup().addTo(this.map);
    this.markerLayer = L.layerGroup().addTo(this.map);
    this.measureLayer = L.layerGroup().addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      const point = { lat: e.latlng.lat, lng: e.latlng.lng };

      // Thước đo GIÀNH QUYỀN click: đang đo mà vẫn để click thêm điểm giao thì
      // mỗi lần đo là đẻ ra một điểm giao ma trong tuyến.
      if (this.measuring()) {
        this.measurePoints.update((list) => [...list, point]);
        return;
      }

      if (!this.pickMode()) return;
      this.mapClick.emit(point);
    });

    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      this.cursor.set({ lat: e.latlng.lat, lng: e.latlng.lng });
    });

    this.map.on('zoomend', () => this.zoomLevel.set(this.map?.getZoom() ?? 12));
    this.zoomLevel.set(this.map.getZoom());

    this.initialized.set(true);

    this.renderPaths(this.paths());
    this.renderCircles(this.circles());
    this.renderMarkers(this.markers());
    this.renderVehicle(this.vehicle());
    this.renderFleet(this.vehicles());
    this.fitContent();
  }

  // ------------------------------------------------------------- lớp bản đồ nền

  /**
   * Đổi lớp nền tại chỗ.
   *
   * Phải GỠ lớp cũ trước khi thêm lớp mới. Quên bước này thì các lớp chồng lên
   * nhau: lớp cũ vẫn nằm dưới, tốn băng thông tải tile vô ích và lớp mới có vùng
   * trong suốt sẽ lộ lớp cũ ra, nhìn như bản đồ bị nhiễu màu.
   */
  private applyBaseLayer(id: string): void {
    if (!this.map) return;

    const def = BASE_LAYERS.find((l) => l.id === id) ?? BASE_LAYERS[0];

    this.baseTile?.remove();
    this.overlayTile?.remove();
    this.overlayTile = undefined;

    this.baseTile = L.tileLayer(def.urlTemplate, {
      maxZoom: def.maxZoom,
      attribution: def.attribution,
      // Màn hình retina: Leaflet tự thay `{r}` thành `@2x` -> tile nét gấp đôi.
      detectRetina: true,
    }).addTo(this.map);

    // Ảnh vệ tinh không có tên đường -> phủ thêm lớp nhãn giao thông trong suốt.
    if (def.overlayUrlTemplate) {
      this.overlayTile = L.tileLayer(def.overlayUrlTemplate, {
        maxZoom: def.maxZoom,
        // `pane: 'overlayPane'` để nhãn nằm TRÊN ảnh vệ tinh nhưng DƯỚI đường vẽ.
        pane: 'overlayPane',
      }).addTo(this.map);
    }

    this.applyDarkClass(def);
  }

  private applyDarkClass(def: BaseLayerDef): void {
    this.mapHost().nativeElement.classList.toggle('osm-map--dark', !!def.dark);
  }

  protected selectLayer(id: string): void {
    this.baseLayerId.set(id);
    this.layerPanelOpen.set(false);
  }

  protected toggleLayerPanel(): void {
    this.layerPanelOpen.update((v) => !v);
  }

  private restoreLayer(): string {
    const saved = localStorage.getItem(OsmMapComponent.LAYER_STORAGE_KEY);
    return saved && BASE_LAYERS.some((l) => l.id === saved) ? saved : DEFAULT_BASE_LAYER_ID;
  }

  // ------------------------------------------------------------------ thước đo

  protected toggleMeasure(): void {
    const next = !this.measuring();
    this.measuring.set(next);
    if (!next) this.measurePoints.set([]);
  }

  protected clearMeasure(): void {
    this.measurePoints.set([]);
  }

  /**
   * Vẽ đường đo + nhãn cộng dồn tại từng điểm.
   * Nhãn hiện quãng đường TÍCH LUỸ chứ không phải từng đoạn — người đo thường
   * muốn biết "từ đầu tới đây bao xa", còn độ dài đoạn lẻ thì tự trừ.
   */
  private renderMeasure(points: readonly LatLng[]): void {
    if (!this.measureLayer) return;
    this.measureLayer.clearLayers();

    if (!points.length) return;

    if (points.length > 1) {
      L.polyline(
        points.map((p) => [p.lat, p.lng] as L.LatLngTuple),
        { color: '#0f172a', weight: 2, dashArray: '6 6' },
      ).addTo(this.measureLayer);
    }

    let cumulative = 0;
    points.forEach((p, i) => {
      if (i > 0) cumulative += distanceMeters(points[i - 1], p);

      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: 'dms-measure-pin',
          html: `<span>${i === 0 ? 'Bắt đầu' : formatDistance(cumulative)}</span>`,
          iconSize: [0, 0],
        }),
        interactive: false,
      }).addTo(this.measureLayer!);
    });
  }

  // -------------------------------------------------------------------- định vị

  /**
   * Định vị trình duyệt.
   *
   * HAI ĐIỀU KIỆN dễ quên: chỉ chạy trên HTTPS (hoặc `localhost`), và người dùng
   * phải bấm đồng ý. Bị từ chối thì im lặng — không dựng hộp thoại lỗi, vì đây
   * là tính năng phụ trợ.
   */
  protected locateMe(): void {
    if (!navigator.geolocation || !this.map) return;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this.flyTo(point, 16);

        L.circle([point.lat, point.lng], {
          radius: Math.max(pos.coords.accuracy, 20),
          color: '#2563eb',
          fillColor: '#3b82f6',
          fillOpacity: 0.15,
          weight: 1,
        }).addTo(this.map!);
      },
      () => void 0,
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  // ---------------------------------------------------------------- markers

  private renderMarkers(items: readonly MapMarker[]): void {
    if (!this.markerLayer) return;
    this.markerLayer.clearLayers();

    for (const m of items) {
      const marker = L.marker([m.lat, m.lng], {
        icon: this.buildIcon(m),
        // Marker đang chọn phải nổi lên trên các marker khác.
        zIndexOffset: m.active ? 1000 : 0,
        riseOnHover: true,
      });

      if (m.title || m.description) {
        marker.bindPopup(this.buildPopup(m), { maxWidth: 280 });
      }
      marker.on('click', () => this.markerClick.emit(m));
      marker.addTo(this.markerLayer);
    }
  }

  /**
   * Marker vẽ bằng HTML (`divIcon`) thay vì ảnh PNG:
   *  - không cần copy `marker-icon.png` vào assets,
   *  - đổi màu/nhãn trực tiếp bằng CSS inline,
   *  - `iconAnchor` phải đặt đúng tâm/đáy, nếu không marker sẽ "trôi" khi zoom.
   */
  private buildIcon(m: MapMarker): L.DivIcon {
    // `safeColor`/`escapeHtml`: `m` có thể mang dữ liệu từ backend (tên khách,
    // nhãn tuỳ biến). Xem `html-safe.util.ts`.
    const color = safeColor(m.color, MAP_COLORS.pending);

    if (m.dot) {
      return L.divIcon({
        className: 'dms-pin dms-pin--dot',
        html: `<span style="background:${color}"></span>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
    }

    const size: [number, number] = m.active ? [34, 34] : [28, 28];
    return L.divIcon({
      className: `dms-pin${m.active ? ' dms-pin--active' : ''}`,
      html: `<span style="background:${color}">${escapeHtml(m.label)}</span>`,
      iconSize: size,
      iconAnchor: [size[0] / 2, size[1] / 2],
    });
  }

  /**
   * Nội dung popup.
   *
   * `title`/`description` là text thuần của nghiệp vụ (tên cửa hàng, địa chỉ,
   * ghi chú) nên phải escape. Link Google Maps dựng lại từ `lat/lng` SỐ đã kiểm
   * tra miền giá trị, không ghép chuỗi thô.
   */
  private buildPopup(m: MapMarker): string {
    const link = safeGeoLink(m.lat, m.lng);

    return `
      <div class="dms-popup">
        <div class="dms-popup__title">${escapeHtml(m.title)}</div>
        ${m.description ? `<div class="dms-popup__body">${escapeHtml(m.description)}</div>` : ''}
        ${
          link
            ? `<a class="dms-popup__link" target="_blank" rel="noopener noreferrer"
           href="${link}">Xem trên Google Maps</a>`
            : ''
        }
      </div>`;
  }

  private renderVehicle(v: MapMarker | null): void {
    if (!this.map) return;

    if (!v) {
      this.vehicleMarker?.remove();
      this.vehicleMarker = undefined;
      return;
    }

    const icon = this.buildVehicleIcon(v);

    if (this.vehicleMarker) {
      // `setLatLng` giữ nguyên node DOM -> CSS transition trong styles.scss làm
      // xe trượt mượt thay vì nhảy cóc giữa 2 lần cập nhật.
      this.vehicleMarker.setLatLng([v.lat, v.lng]);
      this.vehicleMarker.setIcon(icon);
    } else {
      this.vehicleMarker = L.marker([v.lat, v.lng], { icon, zIndexOffset: 2000 }).addTo(this.map);
    }
  }

  /**
   * Nhiều xe cùng lúc (màn điều hành đội xe).
   *
   * Cập nhật TẠI CHỖ theo `key` thay vì xoá sạch rồi vẽ lại: màn điều hành nhích
   * vị trí xe mỗi giây; xoá-vẽ-lại làm marker nhấp nháy và mất hiệu ứng trượt.
   */
  private renderFleet(list: readonly MapMarker[]): void {
    if (!this.map) return;

    const seen = new Set<string>();

    for (const v of list) {
      seen.add(v.key);
      const existing = this.fleetMarkers.get(v.key);
      const icon = this.buildVehicleIcon(v);

      if (existing) {
        existing.setLatLng([v.lat, v.lng]);
        existing.setIcon(icon);
        if (v.title) existing.bindPopup(this.buildPopup(v), { maxWidth: 280 });
        continue;
      }

      const marker = L.marker([v.lat, v.lng], { icon, zIndexOffset: 1500 }).addTo(this.map);
      if (v.title) marker.bindPopup(this.buildPopup(v), { maxWidth: 280 });
      marker.on('click', () => this.markerClick.emit(v));
      this.fleetMarkers.set(v.key, marker);
    }

    for (const [key, marker] of this.fleetMarkers) {
      if (seen.has(key)) continue;
      marker.remove();
      this.fleetMarkers.delete(key);
    }
  }

  private buildVehicleIcon(v: MapMarker): L.DivIcon {
    const color = safeColor(v.color, '#0f172a');
    return L.divIcon({
      className: `dms-vehicle${v.active ? ' dms-vehicle--active' : ''}`,
      html: `<span style="--vehicle-color:${color}">${escapeHtml(v.label ?? '🚚')}</span>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
  }

  // ------------------------------------------------------------------ circles

  /** Geofence — xem chú thích ở `MapCircle`. */
  private renderCircles(items: readonly MapCircle[]): void {
    if (!this.circleLayer) return;
    this.circleLayer.clearLayers();

    for (const c of items) {
      const color = safeColor(c.color, MAP_COLORS.pending);

      const circle = L.circle([c.center.lat, c.center.lng], {
        // MÉT thật, không phải pixel — xem ghi chú số 4 ở đầu file.
        radius: c.radiusMeters,
        color,
        fillColor: color,
        fillOpacity: c.fillOpacity ?? 0.08,
        weight: 1.5,
        dashArray: c.dashed ? '4 6' : undefined,
        // Vòng geofence chỉ để nhìn; bắt sự kiện chuột của nó sẽ che mất marker
        // điểm giao nằm chính giữa.
        interactive: false,
      });

      // `bindTooltip(string)` của Leaflet cũng render như HTML, không phải text.
      if (c.title) circle.bindTooltip(escapeHtml(c.title));
      circle.addTo(this.circleLayer);
    }
  }

  // ------------------------------------------------------------------ paths

  /**
   * Vẽ lại các đường theo kiểu "diff theo key" chứ KHÔNG `clearLayers()` rồi vẽ lại tất cả.
   *
   * Lý do: màn Giám sát giao hàng cập nhật đường "thực tế" mỗi ~200ms khi tua lại
   * hành trình. Nếu xoá sạch rồi vẽ lại thì đường "dự kiến" (cả nghìn điểm, không
   * hề đổi) cũng bị dựng lại theo — SVG của Leaflet phải tính lại toàn bộ path,
   * gây giật rõ rệt. So sánh THAM CHIẾU mảng `points` (signal computed trả về
   * cùng một mảng khi dữ liệu không đổi) là đủ để bỏ qua các đường tĩnh.
   *
   * ⚠️ NHƯNG PHẢI SO CẢ KIỂU VẼ, KHÔNG CHỈ HÌNH HỌC. Bản trước chỉ cập nhật
   * `setLatLngs` cho layer đã có, nên mọi thay đổi màu/độ dày trên một `key`
   * đang tồn tại đều bị bỏ qua: đường dẫn đường đổi sang màu đỏ khi xe đi lệch
   * tuyến thì vẫn hiện màu xanh — hệ thống báo động bằng màu mà màu không bao
   * giờ đổi.
   */
  private renderPaths(items: readonly MapPath[]): void {
    if (!this.pathLayer) return;

    const seen = new Set<string>();

    for (const p of items) {
      if (p.points.length < 2) continue;
      seen.add(p.key);

      const latLngs = p.points.map((pt) => [pt.lat, pt.lng] as L.LatLngTuple);
      const style = this.pathStyle(p);
      const existing = this.pathLayers.get(p.key);

      if (existing) {
        if (existing.points !== p.points) {
          existing.layer.setLatLngs(latLngs);
          existing.points = p.points;
        }
        const signature = JSON.stringify(style);
        if (existing.style !== signature) {
          existing.layer.setStyle(style);
          existing.style = signature;
        }
        continue;
      }

      const layer = L.polyline(latLngs, style).addTo(this.pathLayer);
      this.pathLayers.set(p.key, { layer, points: p.points, style: JSON.stringify(style) });
    }

    // Dọn các đường không còn trong danh sách (tắt lớp hiển thị, đổi chuyến...).
    for (const [key, entry] of this.pathLayers) {
      if (seen.has(key)) continue;
      entry.layer.remove();
      this.pathLayers.delete(key);
    }
  }

  private pathStyle(p: MapPath): L.PolylineOptions {
    return {
      color: safeColor(p.color, MAP_COLORS.real),
      weight: p.weight ?? 5,
      opacity: p.opacity ?? 0.9,
      // Nét đứt của Leaflet: chuỗi "độ dài nét, độ dài khoảng trống".
      dashArray: p.dashed ? '8 10' : undefined,
      lineJoin: 'round',
      lineCap: 'round',
    };
  }

  // --------------------------------------------------------------- viewport

  private collectCoords(
    markers: readonly MapMarker[],
    paths: readonly MapPath[],
    vehicles: readonly MapMarker[],
  ): L.LatLngTuple[] {
    const coords: L.LatLngTuple[] = [];
    for (const p of paths) {
      for (const pt of p.points) coords.push([pt.lat, pt.lng]);
    }
    for (const m of markers) coords.push([m.lat, m.lng]);
    for (const v of vehicles) coords.push([v.lat, v.lng]);

    const single = this.vehicle();
    if (single) coords.push([single.lat, single.lng]);

    return coords;
  }

  /**
   * Fit khung nhìn ôm trọn mọi đường + marker đang hiển thị.
   *
   * ⚠️ `animate` KHÔNG được để `true` vô điều kiện. Leaflet có một cái bẫy im
   * lặng: `_tryAnimatedZoom()` mở đầu bằng `if (this._animatingZoom) return true`
   * — tức là một lần `fitBounds` gọi trong lúc animation trước chưa xong sẽ được
   * báo là "đã xử lý" rồi BỊ BỎ QUA HOÀN TOÀN, không lỗi, không cảnh báo. Đổi
   * chuyến giao hàng bắn ra 2–3 lần fit cách nhau vài trăm mili-giây (marker về
   * trước, tuyến định tuyến về sau) nên lần fit ĐÚNG rất dễ là lần bị bỏ.
   *
   * Vì vậy: nhảy TỨC THÌ khi khung nhìn mới không giao với khung nhìn hiện tại
   * (đổi chuyến sang tỉnh khác — animation lúc này cũng vô nghĩa vì bay ngang
   * qua nửa nước), chỉ animate khi hai khung còn chồng nhau.
   */
  fitContent(): void {
    if (!this.map) return;

    const coords = this.collectCoords(this.markers(), this.paths(), this.vehicles());
    if (!coords.length) return;

    // Huỷ mọi animation đang chạy trước khi đặt khung nhìn mới.
    this.map.stop();

    if (coords.length === 1) {
      this.map.setView(coords[0], 16, { animate: false });
      return;
    }

    const bounds = L.latLngBounds(coords);
    const overlapping = this.map.getBounds().intersects(bounds);

    this.map.fitBounds(bounds, {
      padding: [48, 48],
      maxZoom: 17,
      animate: overlapping,
    });
  }
}
