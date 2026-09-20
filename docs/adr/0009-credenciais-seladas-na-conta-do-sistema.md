# ADR 0009: Credenciais seladas na conta do sistema operativo

## Estado

Aceite e implementado.

## Contexto

O ISPM guarda credenciais que tem de **apresentar a terceiros em tempo de execução**: a senha do
utilizador da API do MikroTik, o token da conta UltraMsg, a chave de pareamento do telemóvel que envia
SMS, e a chave HMAC que assina as sessões. Nenhuma delas pode ser um hash — o sistema precisa do valor
original para o usar.

Até aqui viviam em texto simples em `app_settings`, dentro de um `ispm.sqlite` sem cifra em
`%APPDATA%\ispm\`. O backup de arranque é uma cópia integral desse ficheiro, para onde o `backupDir`
apontar — uma pen, uma partilha de rede, uma pasta sincronizada. Quem apanhasse qualquer uma dessas
cópias ficava com o controlo do router da operadora e da conta de WhatsApp.

As passwords dos utilizadores não têm este problema e não entram nesta decisão: são `scrypt` com sal
aleatório, e nunca precisam de ser recuperadas.

## Decisão

Selar essas quatro credenciais com o `safeStorage` do Electron — DPAPI no Windows, Keychain no macOS,
keyring no Linux. A chave de cifra é da **conta do sistema operativo**, e nunca chega ao disco da
aplicação.

O formato guardado é `enc:v1:<base64>`. Um valor sem esse prefixo é texto simples: é assim que se leem
as instalações que já existem, e é assim que a aplicação continua a funcionar onde não há cifra
disponível.

Toda a leitura e escrita passa por `src/backend/lib/secrets.ts`. **Nenhum chamador vê o `safeStorage`.**

### O que isto protege, e o que não protege

| Cenário | Antes | Depois |
| --- | --- | --- |
| `ispm.sqlite` copiado para outra máquina | credenciais em claro | inútil |
| Backup numa pen, partilha ou pasta sincronizada | credenciais em claro | inútil |
| Disco roubado, outra conta no mesmo computador | credenciais em claro | inútil |
| Código malicioso a correr **como este utilizador** | exposto | exposto na mesma |

A última linha é a honesta: o DPAPI decifra para qualquer processo desse utilizador. Isto eleva a
fasquia; não a torna intransponível.

### O que fica de fora, e porquê

**A base de dados não é cifrada.** Uma chave guardada ao lado do ficheiro que protege não protege nada:
quem copia um copia a outra. O SQLCipher teria esse mesmo problema, mais uma dependência nativa a
recompilar por plataforma.

**`services.pppoe_password` não é selado.** Selá-lo protegia um campo numa base que continua a ter o
nome, o NIF, a morada e o histórico financeiro de toda a gente em claro — e criava uma avaria a sério:
num restauro noutra máquina ficavam centenas de credenciais ilegíveis, e regenerá-las derrubava o parque
inteiro até cada CPE reconectar. A exposição real desse campo era outra, e foi essa que se fechou: a
lista de serviços deixou de o enviar a quem não pode escrever serviços.

## Consequências

**A passagem de selagem corre no arranque**, depois das migrações e **antes** do backup de arranque — não
vale a pena passar a selar segredos para os continuar a copiar em claro para dentro de uma pen. Não é
uma migração SQL de propósito: é idempotente, auto-curativa, e não fica presa à cadeia de migrações
(ver ADR 0003).

**Um backup restaurado noutra máquina ou noutra conta perde estas credenciais** — é a proteção a
funcionar. O arranque deteta-o (cifra disponível, bloco que não abre), limpa os valores para as
Definições não mostrarem uma máscara a fingir que há senha, e deixa a lista do que se perdeu para a
interface avisar. Clientes, faturas e histórico são restaurados na íntegra. A chave das sessões
regenera-se e toda a gente entra de novo.

**Sem cifra disponível nada é apagado.** Um bloco selado que não abre num arranque sem keyring é só um
bloco que esta máquina não sabe abrir hoje.

**A API síncrona do `safeStorage` desaparece no Electron 46**, substituída por `encryptStringAsync` /
`decryptStringAsync` — e o que foi selado com a síncrona abre com a assíncrona. É por isso que tudo
passa por um módulo só: nesse dia mexe-se num ficheiro, e os nove sítios que leem credenciais ficam
onde estão.
