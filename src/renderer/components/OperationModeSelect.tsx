import { OPERATION_MODES, OPERATION_MODE_LABELS, operationModesForType } from '../../shared/operation';
import { createModeSelect, type ModeSelectProps } from './ModeSelect';

const Inner = createModeSelect({
  modes: OPERATION_MODES,
  labels: OPERATION_MODE_LABELS,
  label: 'Operação',
  otherLabel: '+ Outro modo…',
  freePlaceholder: 'ex.: AP Router'
});

type Props = ModeSelectProps & {
  /**
   * O tipo de catálogo do equipamento. Decide que modos se oferecem: a CPE e a
   * antena têm os seus, o resto não recebe os modos de quem capta rádio.
   * Sem tipo — artigo ainda por escolher — vale o conjunto do resto.
   */
  catalogType?: string | null;
};

/** Que papel este aparelho desempenha. Ver `shared/operation.ts`. */
export function OperationModeSelect({ catalogType, ...props }: Props) {
  return <Inner {...props} modes={props.modes ?? operationModesForType(catalogType)} />;
}
