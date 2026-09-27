import type { TopologyLive } from '../../../shared/topology';
import { useLive } from '../router/useLive';

export function useTopologyLive(active: boolean) {
  return useLive<TopologyLive>('http://127.0.0.1:3001/api/topology/live', active, 5_000);
}
