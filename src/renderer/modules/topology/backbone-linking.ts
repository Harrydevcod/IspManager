import type { BackboneApi } from './backbone-api';

/** `backbone:3` → 3. Qualquer outro id devolve null. */
export function parseBackboneNodeId(id: string): number | null {
  if (!id.startsWith('backbone:')) return null;
  const parsed = Number(id.slice('backbone:'.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Só a espinha dorsal se liga pelo gesto: a raiz (que significa "alimentado
 * pela Internet") e as unidades de backbone. As CPE nascem de uma atribuição de
 * serviço e ligam-se na aba Backbone.
 */
export function isConnectableTopologyNode(id: string): boolean {
  return id === 'root:isp' || parseBackboneNodeId(id) !== null;
}

export function isValidBackboneConnection(
  sourceNodeId: string | null,
  targetNodeId: string | null
): boolean {
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return false;
  return isConnectableTopologyNode(sourceNodeId) && parseBackboneNodeId(targetNodeId) !== null;
}

/**
 * Grava "o alvo passa a ser alimentado também pela origem".
 *
 * Acrescenta em vez de substituir: um equipamento multi-WAN soma links (várias
 * Starlink no mesmo router), por isso arrastar uma segunda ligação não pode
 * apagar a primeira. Ligar à raiz retira todas — o alvo volta a receber
 * directamente da Internet.
 *
 * Read-modify-write deliberado sobre o PUT que já existe, em vez de uma rota
 * nova: o `expectedUpdatedAt` que vem do GET transforma uma edição concorrente
 * num 409 com mensagem, em vez de a sobrepor em silêncio. Ciclos, unidades
 * retiradas e conflitos são recusados pelo servidor.
 */
export async function connectBackboneUpstream(
  api: BackboneApi,
  sourceNodeId: string,
  targetNodeId: string
): Promise<void> {
  if (!isValidBackboneConnection(sourceNodeId, targetNodeId)) {
    throw new Error('Ligação inválida: só as unidades de backbone se ligam no mapa');
  }
  const targetId = parseBackboneNodeId(targetNodeId) as number;
  const sourceId = parseBackboneNodeId(sourceNodeId);
  await writeUpstreams(api, targetId, (current) => {
    if (sourceId === null) return [];
    return current.includes(sourceId) ? current : [...current, sourceId];
  });
}

/** Retira uma alimentação; as restantes ficam. Sem nenhuma, o alvo volta à Internet. */
export async function disconnectBackboneUpstream(
  api: BackboneApi,
  deviceId: number,
  upstreamDeviceId: number
): Promise<void> {
  await writeUpstreams(api, deviceId, (current) => current.filter((id) => id !== upstreamDeviceId));
}

async function writeUpstreams(
  api: BackboneApi,
  deviceId: number,
  next: (current: number[]) => number[]
): Promise<void> {
  const detail = await api.getBackbone(deviceId);
  await api.updateBackbone(deviceId, {
    catalogId: detail.catalogId,
    name: detail.name,
    status: detail.status,
    serialNumber: detail.serialNumber,
    assetTag: detail.assetTag,
    ipAddress: detail.ipAddress,
    macAddress: detail.macAddress,
    island: detail.island,
    zone: detail.zone,
    notes: detail.notes,
    upstreamDeviceIds: next(detail.upstreams.map((unit) => unit.id)),
    expectedUpdatedAt: detail.updatedAt
  });
}
