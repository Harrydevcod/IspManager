import type { Migration } from './types';

/**
 * Que aparelho é aquele endereço.
 *
 * O fabricante já se sabia sem perguntar a ninguém: os três primeiros bytes do
 * MAC dão-no de graça pelo registo do IEEE (`oui-data.ts`). Só que o OUI diz
 * "TP-Link Technologies" e nunca "CPE710" — para saber o modelo é preciso
 * perguntar ao próprio equipamento.
 *
 * `model_source` é tão importante como o `model`: um `sysDescr` de SNMP é o
 * aparelho a dizer o que é, o título de uma página de login é um palpite sobre
 * HTML. Guardar de onde veio permite não deixar o palpite apagar o facto — a
 * regra de precedência vive em `persistModel` (`network-discovery.ts`).
 *
 * `model_detail` guarda a resposta em bruto que originou o modelo. Existe para
 * quando a deteção falhar: sem ela, uma linha errada não se consegue explicar
 * nem corrigir a regra que a produziu.
 *
 * O modelo do equipamento **registado** no ISPM não vive aqui de propósito.
 * Esse deriva-se ao vivo do catálogo a cada leitura, senão passava a haver duas
 * verdades sobre o mesmo aparelho e uma delas a envelhecer em silêncio.
 */
const migration: Migration = {
  version: 48,
  name: 'discovery_model',
  sql: `
    ALTER TABLE network_discovery_hosts ADD COLUMN model TEXT;
    ALTER TABLE network_discovery_hosts ADD COLUMN model_source TEXT;
    ALTER TABLE network_discovery_hosts ADD COLUMN model_detail TEXT;
    ALTER TABLE network_discovery_hosts ADD COLUMN model_seen_at TEXT;
  `
};

export default migration;
