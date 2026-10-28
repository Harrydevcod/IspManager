import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../lib/auth';
import { Select } from './Select';

export type RouterOptionLists = {
  profiles: string[]; localAddresses: string[]; dnsServers: string[]; pools: string[];
  interfaceLists: string[]; queues: string[]; addressLists: string[];
};
export type RouterOptions =
  | { status: 'loading' }
  | { status: 'unavailable'; reason: string }
  | ({ status: 'ready' } & RouterOptionLists);

/**
 * O que o router tem para cada campo que o nomeia (perfis, pools, listas, filas). Um
 * pedido por ecrã, partilhado pelos campos; `reload` depois de mexer no router.
 */
export function useRouterOptions(active = true): { options: RouterOptions; reload: () => void } {
  const [options, setOptions] = useState<RouterOptions>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let disposed = false;
    setOptions({ status: 'loading' });
    authFetch('http://127.0.0.1:3001/api/network/router/options')
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body as ({ available: true } & RouterOptionLists) | { available: false; reason: string };
      })
      .then((body) => {
        if (disposed) return;
        setOptions(body.available ? { ...body, status: 'ready' } : { status: 'unavailable', reason: body.reason });
      })
      .catch((error: unknown) => {
        if (!disposed) setOptions({ status: 'unavailable', reason: error instanceof Error ? error.message : 'Não foi possível ler o router.' });
      });
    return () => { disposed = true; };
  }, [active, attempt]);
  return { options, reload: useCallback(() => setAttempt((n) => n + 1), []) };
}

type RouterChoiceProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: RouterOptions;
  list: keyof RouterOptionLists;
  /** Para a dica sem opções: "Não há <noun> no router". */
  noun: string;
  /** Quando vazio é uma escolha válida (ex.: sem perfil de suspensos), o rótulo dela. */
  emptyLabel?: string;
  hint?: string;
};

/**
 * Um valor que existe no router escolhe-se, nunca se escreve: várias opções dão uma lista,
 * uma só vem preenchida, e sem router fica o valor gravado, só para ler.
 */
export function RouterChoice({ label, value, onChange, options, list, noun, emptyLabel, hint }: RouterChoiceProps) {
  const values = options.status === 'ready' ? options[list] : [];
  const only = options.status === 'ready' && values.length === 1 && emptyLabel === undefined ? values[0] : null;

  useEffect(() => {
    if (only !== null && value !== only) onChange(only);
  }, [only, value, onChange]);

  if (options.status !== 'ready') {
    return (
      <Select label={label} value={value} disabled
        hint={options.status === 'loading' ? 'A ler do router…' : `${options.reason} O valor gravado mantém-se.`}>
        <option value={value}>{value || emptyLabel || '—'}</option>
      </Select>
    );
  }

  const orphan = value !== '' && !values.includes(value);
  const error = orphan ? `${value} não existe no router: escolha outro.` : undefined;
  const status = values.length === 0 ? `Não há ${noun} no router.` : only !== null ? 'Única opção no router.' : hint;
  return (
    <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}
      disabled={only !== null || (values.length === 0 && !orphan)} error={error} hint={status}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {emptyLabel === undefined && value === '' && <option value="" disabled>Escolha…</option>}
      {orphan && <option value={value}>{value} (não existe no router)</option>}
      {values.map((option) => <option key={option} value={option}>{option}</option>)}
    </Select>
  );
}
