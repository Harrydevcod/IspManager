/**
 * Chave pública Ed25519 que valida as licenças desta build.
 *
 * Vazia = **licenciamento desligado**: a aplicação comporta-se como sempre se
 * comportou, sem avaliação nem bloqueios. É o valor por omissão de propósito —
 * uma build enganada a ficar sem enforcement descobre-se no primeiro teste de
 * ativação, mas uma build enganada a trancar clientes pagantes em
 * leitura-apenas é um incidente. Falhar para o lado de deixar trabalhar.
 *
 * Para ligar: `npx tsx scripts/issue-license.ts keygen`, guardar a chave
 * PRIVADA fora do repositório (é ela que emite licenças e não pode ser perdida
 * nem partilhada) e colar aqui só a pública.
 *
 * `ISPM_LICENSE_PUBLIC_KEY` sobrepõe-se, para desenvolvimento e testes —
 * incluindo quando é definida como string vazia, que vale por "esta build não
 * tem chave". Um override que não consegue exprimir "nenhuma" não é override, e
 * é essa a única forma de exercitar o caminho de build-sem-chave agora que a
 * constante abaixo vem preenchida.
 */
const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzHjKrykfuSWBTOoooaGV1psmlC1ZIaEgf4PN4inAbZk=
-----END PUBLIC KEY-----`;

export function licensePublicKey(): string {
  return (process.env.ISPM_LICENSE_PUBLIC_KEY ?? EMBEDDED_PUBLIC_KEY).trim();
}

/**
 * O licenciamento só age quando há chave pública configurada e não foi
 * desligado por ambiente (`ISPM_LICENSE=off`, o mesmo padrão de `ISPM_AUTH`).
 */
export function licensingEnabled(): boolean {
  return process.env.ISPM_LICENSE !== 'off' && licensePublicKey() !== '';
}
