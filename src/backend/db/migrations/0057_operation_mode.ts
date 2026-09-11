import type { Migration } from './types';

/**
 * Que papel e que cada equipamento desempenha.
 *
 * A 0056 respondeu a "como e que esta unidade obtem endereco". Falta a outra
 * metade da pergunta que se faz ao chegar a casa de um cliente: o que e que
 * este aparelho esta a fazer? Um TP-Link igual ao do vizinho pode estar a
 * encaminhar, a espalhar Wi-Fi a partir de um cabo, a repetir sinal pelo ar, a
 * converter Wi-Fi em cabo, ou a fazer malha com outros.
 *
 * O tipo de catalogo nao responde a isto. `ap` e `repetidor` existem na lista
 * de tipos mas nao carregam comportamento nenhum, e o papel tem-se escondido no
 * *nome do modelo*: ha `NanoStation AC Loco Ponto de Acesso PoE` registado como
 * `antena` e `CPE 510 Ponto de Acesso para Exterior` registado como `cpe`. A
 * 0046 ja tinha escrito que registar um repetidor como `router` "era o menos
 * errado"; isto e o campo que faltava para deixar de ser preciso escolher o
 * menos errado.
 *
 * Texto livre, pela mesma razao que o tipo o e desde a 0047. Predefinidos em
 * `shared/operation.ts`; um modo escrito a mao e so uma etiqueta.
 *
 * **Sem preenchimento, de proposito.** Ao contrario da 0056 — onde um endereco
 * escrito a mao provava que alguem o tinha fixado — aqui nao ha de onde derivar
 * coisa nenhuma: `ap` tem zero registos no catalogo, o tipo nao diz o papel, e
 * adivinha-lo pelo nome do modelo era inventar dados sobre instalacoes que
 * ninguem verificou. Nulo e honesto: ninguem registou o papel, logo ninguem
 * sabe. O filtro "Por classificar" da a lista de trabalho.
 */
const migration: Migration = {
  version: 57,
  name: 'operation_mode',
  sql: `
    ALTER TABLE service_device_assignments ADD COLUMN operation_mode TEXT;
    ALTER TABLE backbone_devices ADD COLUMN operation_mode TEXT;
  `
};

export default migration;
