import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
// Import SÂU, không qua barrel — xem chú thích trong `app.config.ts`.
import { MAP_ROUTING_CONFIG } from './core/map/map-routing.config';
import { MapProvider } from './core/map/map.types';
import { MapProviderService } from './core/map/map-provider.service';

/**
 * Khung ứng dụng: thanh điều hướng + bộ chọn nhà cung cấp bản đồ.
 *
 * Bộ chọn provider đặt ở đây (cấp app) chứ không ở từng màn: đổi provider là
 * thay đổi TOÀN CỤC, và mọi màn hình đều đọc chung `MapProviderService`.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly mapProvider = inject(MapProviderService);
  protected readonly config = inject(MAP_ROUTING_CONFIG);

  protected readonly providers = [
    {
      value: MapProvider.OpenStreet,
      label: 'OpenStreetMap',
      hint: 'Leaflet + OSRM — không cần API key',
    },
    { value: MapProvider.Google, label: 'Google Maps', hint: 'Routes API v2 — cần API key' },
    { value: MapProvider.Viettel, label: 'Viettel Map', hint: 'vtmap-gl — cần access token' },
  ];

  protected onChangeProvider(event: Event): void {
    this.mapProvider.setProvider((event.target as HTMLSelectElement).value as MapProvider);
  }

  protected get currentHint(): string {
    return this.providers.find((p) => p.value === this.mapProvider.provider())?.hint ?? '';
  }
}
