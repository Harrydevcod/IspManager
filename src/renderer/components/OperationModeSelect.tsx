import { OPERATION_MODES, OPERATION_MODE_LABELS } from '../../shared/operation';
import { createModeSelect, type ModeSelectProps } from './ModeSelect';

const Inner = createModeSelect({
  modes: OPERATION_MODES,
  labels: OPERATION_MODE_LABELS,
  label: 'Operação',
  otherLabel: '+ Outro modo…',
  freePlaceholder: 'ex.: AP Router'
});

/** Que papel este aparelho desempenha. Ver `shared/operation.ts`. */
export function OperationModeSelect(props: ModeSelectProps) {
  return <Inner {...props} />;
}
