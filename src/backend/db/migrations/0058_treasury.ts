import type { Migration } from './types';

/**
 * Tesouraria: onde está o dinheiro.
 *
 * `payment_receipts` diz quanto entrou e como se pagou, mas não onde o dinheiro
 * ficou. O numerário vai para uma caixa física e só depois é depositado; uma
 * transferência cai num banco concreto. Sem isto não há saldos, e "caixa" no
 * código continuava a querer dizer regime de caixa, não uma gaveta com notas.
 *
 * `treasury_accounts` são as caixas e as contas bancárias. As contas bancárias
 * existiam só como texto em `app_settings.bankAccounts` (sem id, para imprimir
 * na fatura); passam a ser linhas desta tabela, com `show_on_documents` a
 * decidir o que vai para o PDF. Nasce ainda uma "Caixa principal" predefinida.
 *
 * `treasury_movements` é um livro-razão só de acrescento: nada se edita nem se
 * apaga. Um erro corrige-se com um `estorno` de sinal contrário, como um
 * documento numerado se anula em vez de se apagar.
 *
 * **Saldo de abertura, não histórico.** Os recibos anteriores não dizem em que
 * conta caiu o dinheiro, e inventá-lo era pior que não saber. Cada conta começa
 * a contar em `opening_date` com `opening_balance_cve` (a zero, para o
 * utilizador acertar com o que conta na caixa e lê no extrato).
 *
 * `account_id` em recibos, despesas e investimentos é nulo em tudo o que já
 * existe, de propósito pela mesma razão.
 */
const migration: Migration = {
  version: 58,
  name: 'treasury',
  sql: `
    CREATE TABLE IF NOT EXISTS treasury_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('caixa','banco')),
      name TEXT NOT NULL,
      bank_name TEXT,
      account_number TEXT,
      holder_name TEXT,
      reference TEXT,
      opening_balance_cve REAL NOT NULL DEFAULT 0,
      opening_date TEXT NOT NULL,
      is_default_cash INTEGER NOT NULL DEFAULT 0 CHECK(is_default_cash IN (0,1)),
      show_on_documents INTEGER NOT NULL DEFAULT 0 CHECK(show_on_documents IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(is_default_cash = 0 OR kind = 'caixa')
    );

    -- Uma só caixa predefinida: é para lá que vai o numerário sem conta escolhida.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_accounts_default_cash
      ON treasury_accounts(is_default_cash) WHERE is_default_cash = 1;

    CREATE TABLE IF NOT EXISTS treasury_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES treasury_accounts(id),
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      amount_cve REAL NOT NULL CHECK(amount_cve > 0),
      movement_date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('recebimento','deposito','transferencia','despesa','investimento','ajuste','estorno')),
      receipt_id INTEGER REFERENCES payment_receipts(id),
      -- Sem FK de propósito: despesas e investimentos apagam-se, e o livro-razão
      -- guarda o id histórico (a saída e o estorno ficam, com a descrição).
      expense_id INTEGER,
      investment_id INTEGER,
      transfer_group TEXT,
      reversal_of_id INTEGER REFERENCES treasury_movements(id),
      reference TEXT,
      description TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(kind <> 'recebimento' OR receipt_id IS NOT NULL),
      CHECK(kind <> 'despesa' OR expense_id IS NOT NULL),
      CHECK(kind <> 'investimento' OR investment_id IS NOT NULL),
      CHECK(kind <> 'estorno' OR reversal_of_id IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_treasury_movements_account_date
      ON treasury_movements(account_id, movement_date);
    CREATE INDEX IF NOT EXISTS idx_treasury_movements_receipt ON treasury_movements(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_treasury_movements_expense ON treasury_movements(expense_id);
    CREATE INDEX IF NOT EXISTS idx_treasury_movements_investment ON treasury_movements(investment_id);
    -- Um movimento estorna-se uma vez; um segundo estorno duplicava a correção.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_movements_reversal
      ON treasury_movements(reversal_of_id) WHERE reversal_of_id IS NOT NULL;

    ALTER TABLE payment_receipts ADD COLUMN account_id INTEGER REFERENCES treasury_accounts(id);
    ALTER TABLE expenses ADD COLUMN account_id INTEGER REFERENCES treasury_accounts(id);
    ALTER TABLE investments ADD COLUMN account_id INTEGER REFERENCES treasury_accounts(id);

    INSERT INTO treasury_accounts (kind, name, opening_date, is_default_cash, sort_order)
    VALUES ('caixa', 'Caixa principal', date('now'), 1, 0);

    -- As contas das Configurações passam a contas a sério, pela ordem em que
    -- estavam, e continuam a sair na fatura.
    INSERT INTO treasury_accounts (
      kind, name, bank_name, account_number, holder_name, reference,
      opening_date, show_on_documents, sort_order
    )
    SELECT
      'banco',
      COALESCE(NULLIF(trim(json_extract(item.value, '$.bankName')), ''), 'Conta bancaria ' || (item.key + 1)),
      NULLIF(trim(json_extract(item.value, '$.bankName')), ''),
      NULLIF(trim(json_extract(item.value, '$.accountNumber')), ''),
      NULLIF(trim(json_extract(item.value, '$.accountName')), ''),
      NULLIF(trim(json_extract(item.value, '$.reference')), ''),
      date('now'),
      1,
      item.key + 1
    FROM app_settings s, json_each(s.value) item
    WHERE s.key = 'bankAccounts' AND json_valid(s.value) AND json_type(s.value) = 'array';
  `
};

export default migration;
