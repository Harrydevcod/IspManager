import { Field } from '../../components';

type IpFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Prefixo sugerido pela rede em uso, ex.: "192.168.1." */
  prefix: string;
};

/**
 * Campo de IP com prefixo sugerido: ao focar um campo vazio preenche a faixa em uso
 * para só faltar o último octeto, e desiste dela se o utilizador sair sem escrever
 * nada. É sugestão, não regra — o campo continua livre para outra faixa ou classe.
 */
export function IpField({ value, onChange, prefix }: IpFieldProps) {
  return (
    <Field
      label="IP"
      value={value}
      placeholder={`${prefix}10`}
      onChange={(event) => onChange(event.target.value)}
      onFocus={() => { if (!value) onChange(prefix); }}
      onBlur={() => { if (value === prefix) onChange(''); }}
    />
  );
}
