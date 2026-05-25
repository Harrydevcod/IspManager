import { Select } from '../../../components';
import type { ColumnMapping, TargetField } from './types';
import { REQUIRED, TARGET_LABEL } from './types';

type ImportColumnMapperProps = {
  headers: string[];
  mapping: ColumnMapping;
  onChange: (target: TargetField, value: string) => void;
};

/** Renders a Select per target field, letting the user remap detected columns. */
export function ImportColumnMapper({ headers, mapping, onChange }: ImportColumnMapperProps) {
  return (
    <section className="import-mapping" aria-label="Mapeamento de colunas">
      {(Object.keys(TARGET_LABEL) as TargetField[]).map((target) => {
        const isRequired = REQUIRED.includes(target);
        return (
          <Select
            key={target}
            label={`${TARGET_LABEL[target]}${isRequired ? ' *' : ''}`}
            className={isRequired ? 'is-required' : undefined}
            value={mapping[target]}
            onChange={(event) => onChange(target, event.target.value)}
          >
            <option value="">(nao mapeado)</option>
            {headers.map((header) => (
              <option key={header} value={header}>{header}</option>
            ))}
          </Select>
        );
      })}
    </section>
  );
}
