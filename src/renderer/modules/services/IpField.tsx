import { Field } from '../../components';

type IpFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Prefixo sugerido pela rede em uso, ex.: "192.168.1." */
  prefix: string;
  /** Nome acessível quando "IP" sozinho não chega — listas com um campo por equipamento. */
  ariaLabel?: string;
  /** Em tabelas, o cabeçalho já diz "IP": o label fica só para leitores de ecrã. */
  hideLabel?: boolean;
  /** CPE e antena não podem ficar sem endereço; o resto pode andar em DHCP. */
  required?: boolean;
};

/**
 * Campo de IP com prefixo sugerido: ao focar um campo vazio preenche a faixa em uso
 * para só faltar o último octeto, e desiste dela se o utilizador sair sem escrever
 * nada. É sugestão, não regra — o campo continua livre para outra faixa ou classe.
 */
export function IpField({ value, onChange, prefix, ariaLabel, hideLabel, required }: IpFieldProps) {
  return (
    <Field
      label="IP"
      hideLabel={hideLabel}
      aria-label={ariaLabel}
      required={required}
      // Deixar em branco é uma decisão, não um esquecimento: dizê-lo poupa a
      // dúvida de quem instala um router e não sabe se pode saltar o campo.
      hint={required || hideLabel ? undefined : 'Vazio = DHCP'}
      value={value}
      placeholder={`${prefix}10`}
      onChange={(event) => onChange(event.target.value)}
      onFocus={() => { if (!value) onChange(prefix); }}
      onBlur={() => { if (value === prefix) onChange(''); }}
    />
  );
}
