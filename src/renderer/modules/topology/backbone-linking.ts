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
 * Grava "o alvo passa a ser alimentado pela origem".
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
  const targetId = parseBackboneNodeId(targetNodeId)!;
  const detail = await api.getBackbone(targetId);
  await api.updateBackbone(targetId, {
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
    upstreamDeviceId: parseBackboneNodeId(sourceNodeId),
    expectedUpdatedAt: detail.updatedAt
  });
}
