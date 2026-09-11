import { WAN_MODES, WAN_MODE_LABELS } from '../../shared/wan';
import { createModeSelect, type ModeSelectProps } from './ModeSelect';

const Inner = createModeSelect({
  modes: WAN_MODES,
  labels: WAN_MODE_LABELS,
  label: 'Ligação',
  otherLabel: '+ Outro modo…',
  freePlaceholder: 'ex.: IPv6 nativo'
});

/** Como esta unidade obtém endereço. Ver `shared/wan.ts`. */
export function WanModeSelect(props: ModeSelectProps) {
  return <Inner {...props} />;
}
