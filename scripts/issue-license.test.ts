import { describe, expect, it } from 'vitest';
import { customerFolder } from './issue-license';

describe('customerFolder', () => {
  it('normaliza o nome comercial', () => {
    expect(customerFolder('Tony Alves')).toBe('tony-alves');
    expect(customerFolder('NOVATECH CV SOCIEDADE UNIPESSOAL LDA')).toBe('novatech-cv-sociedade-unipessoal-lda');
  });

  it('tira acentos em vez de os partir', () => {
    // "João Pêra" tem de dar joao-pera, não joa-o-pe-ra.
    expect(customerFolder('João Pêra')).toBe('joao-pera');
  });

  it('junta o NIF, que é o que distingue homónimos', () => {
    expect(customerFolder('Tony Alves', '211082600')).toBe('tony-alves-211082600');
    expect(customerFolder('Tony Alves')).not.toContain('211082600');
  });

  it('nunca devolve um caminho — só um segmento', () => {
    // O slug é a própria guarda: sem barras, sem pontos, sem escapar da pasta.
    expect(customerFolder('../../.ssh')).toBe('ssh');
    expect(customerFolder('C:\\Windows\\System32')).toBe('c-windows-system32');
    for (const name of ['../../.ssh', 'a/b', '..', 'x\\y']) {
      expect(customerFolder(name)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('não deixa uma pasta sem nome', () => {
    expect(customerFolder('***')).toBe('cliente');
    expect(customerFolder('   ')).toBe('cliente');
    expect(customerFolder('***', '211082600')).toBe('cliente-211082600');
  });

  it('corta nomes longos sem deixar hífen pendurado', () => {
    const folder = customerFolder('a'.repeat(80));
    expect(folder).toHaveLength(60);
    const cut = customerFolder(`${'ab '.repeat(20)}fim`);
    expect(cut.endsWith('-')).toBe(false);
  });
});
