import type { Migration } from './types';

/**
 * Estado em que o equipamento voltou.
 *
 * Até aqui devolver era sempre a mesma coisa: fechar a atribuição e somar 1 ao
 * stock. Só que uma unidade que volta partida — ou que o cliente nunca devolveu
 * — não está disponível para instalar em mais ninguém. O stock passava a mentir
 * exatamente no momento em que o cliente cancela, que é quando isto acontece.
 *
 * `return_condition` fica NULL enquanto a atribuição está ativa e passa a
 * 'bom' | 'avariado' | 'nao_devolvido' na devolução. Só 'bom' repõe stock; nos
 * outros dois casos a unidade fica onde já estava desde a instalação — fora do
 * armazém — e o custo continua registado no movimento de `saida` original.
 *
 * Sem CHECK: o SQLite não altera um CHECK no sítio e não vale um rebuild da
 * tabela por um campo de texto; a lista fechada é validada no Zod da rota.
 */
const migration: Migration = {
  version: 44,
  name: 'return_condition',
  sql: `
    ALTER TABLE service_device_assignments
      ADD COLUMN return_condition TEXT;
  `
};

export default migration;
