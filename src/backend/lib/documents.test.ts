import { describe, expect, test } from 'vitest';
import { documentStatusLabel, foldRentalLines, rentalDeviceName, serviceAcronym, RENTAL_DETAIL_HEADING, RENTAL_ONLY_DESCRIPTION } from './documents';

describe('estado no documento', () => {
  test('le-se em portugues, nunca o codigo da base', () => {
    expect(documentStatusLabel('pending')).toBe('PENDENTE');
    expect(documentStatusLabel('partial')).toBe('PARCIAL');
    expect(documentStatusLabel('overdue')).toBe('EM ATRASO');
    expect(documentStatusLabel('cancelled')).toBe('ANULADA');
  });

  test('estado desconhecido nao vaza para a fatura', () => {
    expect(documentStatusLabel(null)).toBe('-');
    expect(documentStatusLabel('whatever')).toBe('-');
  });
});

describe('aluguer na fatura', () => {
  const internet = { kind: 'internet' as const, description: 'Servico de Internet', amountCve: 2500 };
  const audiovisual = { kind: 'audiovisual' as const, description: 'Audiovisual', amountCve: 500 };
  const rental = (amountCve: number, model: string) =>
    ({ kind: 'aluguer' as const, description: `Aluguer — ${model}`, amountCve });

  const total = (lines: Array<{ amountCve: number }>) => lines.reduce((sum, l) => sum + l.amountCve, 0);

  test('a renda desaparece dentro da mensalidade', () => {
    const lines = [internet, rental(250, 'TP-Link CPE510')];
    const { items, hasRental } = foldRentalLines(lines);
    expect(hasRental).toBe(true);
    expect(items).toEqual([{ ...internet, amountCve: 2750 }]);
    expect(total(items)).toBe(total(lines));
  });

  test('varios equipamentos somam-se todos na mesma linha', () => {
    const lines = [internet, audiovisual, rental(250, 'CPE510'), rental(250, 'RB760')];
    const { items, hasRental } = foldRentalLines(lines);
    expect(hasRental).toBe(true);
    expect(items.map((l) => l.kind)).toEqual(['internet', 'audiovisual']);
    expect(items[0].amountCve).toBe(3000);
    expect(total(items)).toBe(total(lines));
  });

  test('sem mensalidade (servico suspenso) sobra uma linha discreta e anonima', () => {
    const lines = [rental(250, 'CPE510'), rental(250, 'RB760')];
    const { items, hasRental } = foldRentalLines(lines);
    // Sem linha de internet nao ha nota a por — a propria linha e a discricao.
    expect(hasRental).toBe(false);
    expect(items).toEqual([{ kind: 'aluguer', description: RENTAL_ONLY_DESCRIPTION, amountCve: 500 }]);
    expect(total(items)).toBe(total(lines));
  });

  test('o modelo do equipamento nunca entra na rubrica', () => {
    // Com a definicao ligada o modelo sai numa sub-linha; a rubrica principal
    // continua a ser so a mensalidade.
    const { items } = foldRentalLines([internet, rental(250, 'TP-Link CPE510')]);
    expect(items.some((l) => l.description.includes('CPE510'))).toBe(false);
    expect(items.some((l) => l.description.includes('Aluguer'))).toBe(false);
  });

  test('fatura sem aluguer fica exactamente como estava', () => {
    const lines = [internet, audiovisual];
    const { items, hasRental } = foldRentalLines(lines);
    expect(items).toBe(lines);
    expect(hasRental).toBe(false);
  });
});

describe('detalhe do aluguer (printRentalLines)', () => {
  const internet = { kind: 'internet' as const, description: 'Servico de Internet', amountCve: 2500 };
  const rental = (amountCve: number, model: string) =>
    ({ kind: 'aluguer' as const, description: `Aluguer — ${model}`, amountCve });

  test('cada equipamento sobrevive com nome e valor proprios', () => {
    const { items, rentals } = foldRentalLines([internet, rental(250, 'CPE510'), rental(150, 'RB760')]);
    expect(rentals.map((r) => [rentalDeviceName(r.description), r.amountCve])).toEqual([
      ['CPE510', 250],
      ['RB760', 150]
    ]);
    // O valor impresso no plano e o mesmo com ou sem detalhe.
    expect(items[0].amountCve).toBe(2900);
  });

  test('sem aluguer nao ha nada para detalhar', () => {
    expect(foldRentalLines([internet]).rentals).toEqual([]);
  });

  test('o nome imprime-se sem o prefixo, que ja esta no cabecalho', () => {
    expect(RENTAL_DETAIL_HEADING).toBe('Aluguer de equipamento');
    expect(rentalDeviceName('Aluguer — TP-Link CPE510')).toBe('TP-Link CPE510');
  });

  test('descricao fora do padrao passa inteira em vez de ficar vazia', () => {
    expect(rentalDeviceName('Renda do router')).toBe('Renda do router');
    expect(rentalDeviceName('Aluguer — ')).toBe('Aluguer — ');
  });
});

describe('sigla da rubrica', () => {
  test('o nome legal do audiovisual encolhe para as iniciais', () => {
    expect(serviceAcronym('Distribuição de Conteúdos Audiovisuais')).toBe('DCA');
  });

  test('as ligacoes nao contam, com ou sem acento', () => {
    expect(serviceAcronym('Servico de Apoio a Domicilio')).toBe('SAD');
    expect(serviceAcronym('Gestão e Manutenção de Redes')).toBe('GMR');
  });

  test('nome curto de mais fica inteiro', () => {
    // Uma sigla de uma letra nao diz nada — mais vale o nome.
    expect(serviceAcronym('Internet')).toBe('Internet');
    expect(serviceAcronym('Servico de Internet')).toBe('SI');
  });

  test('o tracao separa palavras como o espaco', () => {
    expect(serviceAcronym('Video-Vigilancia Remota')).toBe('VVR');
  });
});
