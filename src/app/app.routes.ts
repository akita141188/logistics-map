import { Routes } from '@angular/router';

/**
 * Cả hai màn đều `loadComponent` (lazy): Leaflet ~150KB và SDK bản đồ chỉ được
 * tải khi người dùng thực sự mở màn bản đồ, không nằm trong bundle khởi động.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'fleet' },
  {
    path: 'fleet',
    title: 'Điều hành đội xe — DMS Logistics',
    loadComponent: () => import('./features/fleet/fleet-board.page').then((m) => m.FleetBoardPage),
  },
  {
    path: 'planning',
    title: 'Lập kế hoạch & phân xe — DMS Logistics',
    loadComponent: () =>
      import('./features/planning/planning.page').then((m) => m.PlanningPage),
  },
  {
    path: 'delivery',
    title: 'Giám sát lộ trình giao hàng — DMS Logistics',
    loadComponent: () =>
      import('./features/delivery/delivery-monitor.page').then((m) => m.DeliveryMonitorPage),
  },
  {
    path: 'navigate',
    title: 'Dẫn đường tài xế — DMS Logistics',
    loadComponent: () => import('./features/navigate/navigate.page').then((m) => m.NavigatePage),
  },
  {
    path: 'directions',
    title: 'Chỉ đường — DMS Logistics',
    loadComponent: () =>
      import('./features/directions/directions.page').then((m) => m.DirectionsPage),
  },
  { path: '**', redirectTo: 'fleet' },
];
