import type { Migration } from './types';

/**
 * Como e que cada equipamento obtem o seu endereco.
 *
 * Ate aqui o registo dizia *onde* um equipamento esta — IP, MAC, modelo — e
 * nunca *em que modo* foi configurado. A unica pista era uma convencao
 * implicita: campo de IP vazio queria dizer DHCP, e a obrigatoriedade do
 * endereco saia do tipo de catalogo (CPE e antena), com o tipo a fazer de
 * substituto de uma pergunta que ninguem fazia.
 *
 * Deixou de chegar. O parque mistura TP-Link em IP fixo, routers de cliente em
 * DHCP e, desde a 0039, clientes com identidade PPPoE — e nada dizia que
 * *aquela unidade* estava configurada em PPPoE. Quem vai ao terreno pergunta
 * sempre a mesma coisa, e a resposta vivia na cabeca de alguem.
 *
 * Texto livre e nao lista fechada, pela mesma razao que o tipo de equipamento o
 * e desde a 0047: o terreno inventa arranjos que uma lista nossa nao
 * anteciparia. Os predefinidos vivem em `shared/wan.ts`; um modo escrito a mao
 * e so uma etiqueta.
 *
 * O preenchimento e de proposito incompleto. Quem tem endereco registado passa
 * a `static`, porque um endereco escrito a mao so existe se alguem o fixou.
 * Quem nao tem fica **nulo** — por classificar — e nao `dhcp`: um CPE sem
 * endereco e hoje uma atencao no mapa (`missing_ip`), e dar-lhe `dhcp` apagava
 * o aviso em silencio. Nulo guarda o sinal e da ao operador a lista de trabalho
 * verdadeira, para classificar o parque ao ritmo do terreno — equipamento a
 * equipamento, como o ADR 0008 fez com as credenciais PPPoE.
 */
const migration: Migration = {
  version: 56,
  name: 'wan_mode',
  sql: `
    ALTER TABLE service_device_assignments ADD COLUMN wan_mode TEXT;
    ALTER TABLE backbone_devices ADD COLUMN wan_mode TEXT;

    UPDATE service_device_assignments
      SET wan_mode = 'static'
      WHERE trim(coalesce(ip_address, '')) <> '';

    UPDATE backbone_devices
      SET wan_mode = 'static'
      WHERE trim(coalesce(ip_address, '')) <> '';
  `
};

export default migration;
