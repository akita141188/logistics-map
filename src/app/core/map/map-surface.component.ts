import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { GoogleMapComponent } from './google/google-map.component';
import { MapProviderService } from './map-provider.service';
import { LatLng, MapCircle, MapMarker, MapPath, MapProvider } from './map.types';
import { OsmMapComponent } from './osm/osm-map.component';
import { ViettelMapComponent } from './viettel/viettel-map.component';

/**
 * "Mặt bàn vẽ" dùng chung — thay thế `MapContainer.vue`.
 *
 * Mọi màn nghiệp vụ (Chỉ đường, Giám sát giao hàng) chỉ làm việc với component
 * này và với các kiểu dữ liệu trung lập (`MapMarker`, `MapPath`, `LatLng`).
 * Việc đổi nhà cung cấp bản đồ KHÔNG kéo theo sửa code màn hình.
 *
 * Bên Vue chỗ này là một `<template>` với `v-if="mapType === 'VTMAP'"` … lồng ba
 * tầng cùng một đống prop lặp lại; ở đây dùng `@switch` + `MapProviderService`.
 *
 * QUY ƯỚC PHÂN VAI:
 *  - `paths`         : hình học ĐÃ CÓ SẴN (do màn hình tự gọi service định tuyến).
 *                      Mọi provider đều vẽ được.
 *  - `routingPoints` : danh sách điểm để **Viettel `RoadDrawerControl` tự định tuyến**.
 *                      Chỉ nhánh VTMAP dùng — đây là cách duy nhất SDK Viettel
 *                      trả về đường đi.
 *  - `fitToken`      : đổi giá trị = "hãy ôm trọn dữ liệu hiện tại vào khung nhìn".
 *  - `focus`         : bay tới một điểm cụ thể.
 *
 * ⚠️ `fitToken` và `focus` PHẢI được cả ba nhánh thực hiện. Trước đây chỉ nhánh
 * OpenStreetMap nhận hai input này, còn Google/Viettel thì `focus` bị nhồi vào
 * `[center]` (chỉ có tác dụng lúc khởi tạo) và `fitToken` bị bỏ hẳn. Hậu quả:
 * đổi chuyến giao hàng trên nền Google/Viettel là bản đồ đứng nguyên ở tỉnh cũ,
 * người dùng phải tự kéo đi tìm tuyến mới — đúng lớp bug "đổi nhà cung cấp bản
 * đồ thì màn hình mất tính năng" mà lớp trừu tượng này tồn tại để ngăn.
 */
@Component({
  selector: 'dms-map-surface',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OsmMapComponent, GoogleMapComponent, ViettelMapComponent],
  template: `
    @switch (mapProvider.provider()) {
      @case (Provider.Viettel) {
        <dms-viettel-map
          [center]="center()"
          [zoom]="zoom()"
          [markers]="markers()"
          [paths]="paths()"
          [vehicle]="vehicle()"
          [pickMode]="pickMode()"
          [routingPoints]="routingPoints()"
          [fitToken]="fitToken()"
          [focus]="focus()"
          (mapClick)="mapClick.emit($event)"
          (markerClick)="markerClick.emit($event)"
        />
      }
      @case (Provider.Google) {
        <dms-google-map
          [center]="center()"
          [zoom]="zoom()"
          [markers]="markers()"
          [paths]="paths()"
          [circles]="circles()"
          [vehicle]="vehicle()"
          [pickMode]="pickMode()"
          [fitToken]="fitToken()"
          [focus]="focus()"
          (mapClick)="mapClick.emit($event)"
          (markerClick)="markerClick.emit($event)"
        />
      }
      @default {
        <dms-osm-map
          [center]="center()"
          [zoom]="zoom()"
          [markers]="markers()"
          [paths]="paths()"
          [circles]="circles()"
          [vehicle]="vehicle()"
          [vehicles]="vehicles()"
          [pickMode]="pickMode()"
          [fitToken]="fitToken()"
          [focus]="focus()"
          (mapClick)="mapClick.emit($event)"
          (markerClick)="markerClick.emit($event)"
        />
      }
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
  `,
})
export class MapSurfaceComponent {
  protected readonly mapProvider = inject(MapProviderService);
  protected readonly Provider = MapProvider;

  readonly center = input<LatLng>({ lat: 21.0278, lng: 105.8342 });
  readonly zoom = input(12);
  readonly markers = input<readonly MapMarker[]>([]);
  readonly paths = input<readonly MapPath[]>([]);
  /**
   * Vùng tròn (geofence) — nhánh OpenStreetMap và Google đều vẽ được, cùng nhận
   * bán kính theo MÉT nên không cần lớp quy đổi.
   *
   * Riêng Viettel thì không: `vtmap-gl` không có primitive hình tròn theo mét,
   * phải tự sinh đa giác 64 đỉnh rồi đẩy vào một GeoJSON source — thêm một lớp
   * trừu tượng nữa mà không kiểm chứng được ở đây, nên tạm bỏ trống thay vì viết
   * một nhánh code chưa từng chạy.
   */
  readonly circles = input<readonly MapCircle[]>([]);
  readonly vehicle = input<MapMarker | null>(null);
  /** Nhiều xe cùng lúc — màn điều hành đội xe (hiện chỉ nhánh OSM). */
  readonly vehicles = input<readonly MapMarker[]>([]);
  readonly pickMode = input(false);
  readonly routingPoints = input<readonly LatLng[]>([]);
  readonly fitToken = input<string | number>(0);
  /** Bay tới điểm này (bấm vào một chỉ dẫn rẽ, vào một điểm giao...). */
  readonly focus = input<LatLng | null>(null);

  readonly mapClick = output<LatLng>();
  readonly markerClick = output<MapMarker>();
}
