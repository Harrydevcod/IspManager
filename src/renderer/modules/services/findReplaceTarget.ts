import type { DeviceAssignment } from '../../types';

/**
 * Qual equipamento é que a Descoberta mandou substituir.
 *
 * A Descoberta manda um id de atribuição e a lista chega assíncrona, por isso a
 * escolha vive à parte: é a única lógica desta ponte que pode enganar-se, e é
 * pequena o suficiente para se testar sem montar o módulo todo.
 *
 * As condições são as mesmas do botão "Substituir" que existe na linha
 * (`ServiceDetailDialog.tsx`): titular, por encerrar, e com permissão técnica.
 * Não pode abrir-se por atalho um diálogo que ninguém conseguiria abrir à mão —
 * a porta é a mesma, o atalho só evita o caminho a pé.
 */
export function findReplaceTarget(
  assignments: readonly DeviceAssignment[],
  assignmentId: number | null | undefined,
  canRecordTechnical: boolean
): DeviceAssignment | null {
  if (!assignmentId || !canRecordTechnical) return null;
  const found = assignments.find((assignment) => assignment.id === assignmentId);
  if (!found || found.endDate || !found.isOwner) return null;
  return found;
}
