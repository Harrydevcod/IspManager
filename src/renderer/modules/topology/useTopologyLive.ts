import { apiUrl } from '../../lib/api';
import type { TopologyLive } from '../../../shared/topology';
import { useLive } from '../router/useLive';

export function useTopologyLive(active: boolean) {
  return useLive<TopologyLive>(apiUrl('/api/topology/live'), active, 5_000);
}
