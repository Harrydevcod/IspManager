# Emitir licenças do ISPM

Tutorial do **emissor** — a ferramenta do fornecedor que assina as licenças vendidas.
A decisão de arquitetura por trás disto está em [`docs/adr/0006-offline-signed-licensing.md`](../adr/0006-offline-signed-licensing.md);
aqui está só o como.

---

## 1. O que é uma licença, em três linhas

Um ficheiro `.ispmlic` com um **JSON assinado com Ed25519**. A chave privada vive
na tua máquina e é a única coisa no mundo que consegue emitir licenças. A chave
pública está embebida na build do ISPM (`src/backend/lib/license-key.ts`), por isso
a verificação é **local e offline** — o computador do cliente nunca precisa de rede
para saber se está licenciado.

Não há servidor de licenças. Não há chamadas para casa. Uma licença é um ficheiro
que envias por email ou WhatsApp e o cliente carrega na aplicação.

---

## 2. Onde está o emissor

```
C:\Users\Arydson\Downloads\ispm\scripts\issue-license.ts
```

É um script do **repositório**, não faz parte da aplicação instalada — o cliente
nunca lhe toca. Corre-se com `npx tsx` a partir da pasta do projeto:

```powershell
cd C:\Users\Arydson\Downloads\ispm
npx tsx scripts/issue-license.ts
```

Sem argumentos imprime a ajuda. **`keygen`, `issue`, `verify` e `fingerprint` são
subcomandos** — escrever `issue` sozinho no PowerShell dá
`CommandNotFoundException`, porque o PowerShell não conhece esse comando. Tem de
vir sempre a seguir a `npx tsx scripts/issue-license.ts`.

### O cofre

Tudo o que o emissor produz vive **fora do repositório**, em `~\.ispm-license\`
(sobreponível com a variável de ambiente `ISPM_LICENSE_DIR`):

| Ficheiro | O que é |
|---|---|
| `private.pem` | **A chave privada.** Perdê-la obriga a reemitir todas as licenças; expô-la entrega o produto. Cópia de segurança obrigatória, fora do PC. Nunca em git. |
| `public.pem` | A chave pública. É a que está colada no código. |
| `registry.json` | O registo de todas as emissões — é o teu livro de vendas enquanto a cobrança for manual. |
| `emitidas\` | Os `.ispmlic` gerados, **uma pasta por titular**. |

### Uma pasta por titular

Cada emissão cai na pasta do cliente, para saberes de quem é cada ficheiro sem
abrir o registo. A pasta é o nome normalizado mais o **NIF** — o nome sozinho não
identifica ninguém, dois clientes podem chamar-se "Tony Alves":

```
~\.ispm-license\emitidas\
├── novatech-cv-sociedade-unipessoal-lda-211082600\
│   └── LIC-2026-0001.ispmlic
└── tony-alves-2XXXXXXXX\
    ├── LIC-2026-0002.ispmlic
    └── LIC-2027-0009.ispmlic      ← renovação, mesma pasta
```

Emitir sem `--nif` dá uma pasta só com o nome. Quando o NIF aparecer numa emissão
seguinte, o emissor **renomeia a pasta** e leva as licenças antigas com ele — um
titular, uma pasta.

---

## 3. Os quatro comandos

### `keygen` — cria o par de chaves

```powershell
npx tsx scripts/issue-license.ts keygen
```

**Corre-se uma vez na vida do produto. Já foi corrido em 2026-08-11.** O script
recusa-se a correr outra vez se já existir `private.pem`, e ainda bem: gerar um par
novo invalidaria instantaneamente todas as licenças já vendidas, porque a chave
pública dentro das builds em campo deixaria de bater certo com a assinatura.

Só precisas dele outra vez se algum dia decidires rodar as chaves — e isso implica
reemitir e redistribuir tudo, mais uma nova versão da aplicação.

### `fingerprint` — impressão digital desta máquina

```powershell
npx tsx scripts/issue-license.ts fingerprint
```

Imprime o hash que identifica o computador **onde o comando corre**. Cuidado com a
armadilha: corrido no teu PC dá o teu hash, não o do cliente. Para uma licença
ligada à máquina do cliente, o hash tem de vir do ecrã **Definições → Licença** da
instalação dele.

O hash é `sha256(hostname | plataforma | arquitetura | modelo do CPU)`, truncado a
32 caracteres. RAM e endereços MAC ficaram deliberadamente de fora — aumentar
memória ou ligar um adaptador USB nunca pode invalidar a licença de ninguém.
Renomear o PC ou trocar o CPU, esses sim, obrigam a reemitir.

### `issue` — emite a licença

O comando que interessa no dia-a-dia. Detalhado na secção 4.

### `verify` — inspeciona uma licença emitida

```powershell
npx tsx scripts/issue-license.ts verify $HOME\.ispm-license\emitidas\LIC-2026-0002.ispmlic
```

Valida a assinatura e imprime o claim em JSON. Usa-o sempre antes de enviar um
ficheiro ao cliente: é o que garante que enviaste o ficheiro certo, com as datas
certas e para o cliente certo.

---

## 4. `issue` — todas as opções

```powershell
npx tsx scripts/issue-license.ts issue --customer "Tony Alves" --kind subscricao --months 12
```

| Opção | Omissão | O que faz |
|---|---|---|
| `--customer <nome>` | **obrigatório** | Nome do cliente. Aparece no ecrã de licença dele (*"Subscrição ativa — Tony Alves"*). Usa o nome comercial completo, é o que serve de prova. |
| `--nif <nif>` | — | NIF cabo-verdiano do cliente. Validado: 9 dígitos começados por **1** (singular) ou **2** (coletiva). Opcional, mas põe-no: além de ligar a licença à faturação, é o que **identifica o titular e nomeia a pasta dele**. |
| `--kind <tipo>` | `subscricao` | `subscricao` = expira e tem de ser renovada. `perpetua` = nunca expira; o que caduca é a manutenção. Ver secção 5. |
| `--bind <modo>` | `none` | `none` = chave simples, funciona em qualquer máquina. `machine` = só funciona no computador cuja impressão digital foi gravada na licença. Ver secção 6. |
| `--fingerprint <hash>` | — | **Obrigatório com `--bind machine`.** O hash da máquina do cliente, lido no ecrã Definições → Licença dele. |
| `--months <n>` | `12` | Numa subscrição, meses de validade. Numa perpétua, meses de **manutenção**. Inteiro positivo. O cálculo mantém o dia do mês (31-01 + 1 mês → 28-02, nunca 03-03). |
| `--grace <n>` | `14` | Dias de tolerância **depois** de a subscrição expirar, durante os quais o cliente continua a trabalhar normalmente com um aviso no ecrã. Máximo 365. Irrelevante nas perpétuas. |
| `--id <LIC-AAAA-NNNN>` | automático | Força a referência. Por omissão o script lê o `registry.json` e usa o número seguinte do ano corrente. Só usas isto para reemitir com a **mesma** referência (renovação, transferência de máquina). |
| `--out <ficheiro>` | `emitidas\<titular>\<id>.ispmlic` | Destino do ficheiro. Indicá-lo salta a pasta do titular — útil para escrever direto para uma pasta que vais anexar a um email. |

Cada emissão acrescenta uma linha ao `registry.json`. O ficheiro gerado é texto —
podes abri-lo, mas não editar: qualquer alteração parte a assinatura e a aplicação
rejeita-a.

---

## 5. Subscrição vs. perpétua

**`--kind subscricao`** grava `expiresAt`. Passada essa data o cliente entra em
tolerância (`--grace`, 14 dias) e depois em **leitura-apenas**. Renovar = emitir
ficheiro novo e enviar.

**`--kind perpetua`** nunca expira. O schema **rejeita** uma perpétua com data de
validade — um engano do emissor não pode matar uma licença vitalícia paga. O que os
`--months` definem aqui é `maintenanceUntil`: passada essa data a aplicação continua
a funcionar para sempre, apenas deixa de ter direito a atualizações.

A tua própria licença (`LIC-2026-0001`, Novatech CV) é perpétua.

---

## 6. `--bind none` ou `--bind machine`?

`none` é uma chave simples: o cliente ativa-a onde quiser, e pode copiá-la para
outro ISP. `machine` prende-a a uma instalação — é o que trava a cópia casual entre
operadores, que é exatamente o risco real neste mercado.

O custo do `machine` é operacional: obriga a um vaivém antes da venda (pedir o hash)
e a uma reemissão sempre que o cliente troca de computador, formata, ou renomeia a
máquina. Para o primeiro cliente, `none` tira atrito da venda. Quando forem dez,
passa a `machine`.

Nota: a proteção é do lado do cliente e um atacante determinado reempacota o
Electron e contorna-a. É aceite de propósito — o alvo é a cópia casual e o uso
continuado depois de expirar, não engenharia reversa.

---

## 7. Os cinco estados no computador do cliente

O que o cliente vê depende do estado calculado a cada pedido:

| Estado | Quando | Pode escrever? | Atualizações? |
|---|---|---|---|
| `trial` | Sem licença, dentro dos 30 dias de avaliação | ✅ | ✅ |
| `active` | Licença válida | ✅ | ✅ |
| `grace` | Subscrição expirada, dentro dos dias de tolerância | ✅ (com aviso) | ✅ |
| `readonly` | Avaliação terminada ou tolerância esgotada | ❌ | ❌ |
| `invalid` | Assinatura errada, ficheiro adulterado, ou máquina errada | ❌ | ❌ |

**O pior estado possível é `readonly`, nunca "trancado".** Escritas devolvem `402`,
mas consultar, imprimir documentos e exportar continuam a funcionar — e todo o
subsistema de cópias de segurança, **incluindo restaurar**, está isento do portão.
Os dados são do cliente; recuperá-los nunca depende de estar em dia connosco. O
login também está isento, senão o cliente ficava fora da própria aplicação.

As tarefas automáticas (faturação, despesas recorrentes, avisos de dívida) param em
`readonly`, pela coerência óbvia: não se pode faturar automaticamente o que a
interface se recusa a faturar. Quando a licença é renovada, o catch-up da faturação
automática regenera os meses saltados sem deixar buracos na numeração.

---

## 8. Do lado do cliente

**Ativar:** Definições → Licença → carregar o `.ispmlic`. Qualquer utilizador o
pode fazer, de propósito — quem está bloqueado a meio da manhã raramente é quem tem
a password de administrador. O risco é nulo: só uma licença com assinatura válida,
dentro da validade e para aquela máquina é aceite, e uma licença rejeitada nunca
substitui a que já lá está. Fica registado no log de auditoria quem ativou.

**Remover:** exige perfil **admin** e a password outra vez. É a ação que põe a
instalação em leitura-apenas, por isso pede confirmação de identidade.

A licença é gravada em `license.json` na pasta de dados, **fora da base de dados**.
Assim, restaurar um backup feito noutra máquina não transporta a licença junto com
os dados.

---

## 9. Receitas

**Primeiro cliente, um ano:**
```powershell
cd C:\Users\Arydson\Downloads\ispm
npx tsx scripts/issue-license.ts issue --customer "Tony Alves" --nif 2XXXXXXXX --kind subscricao --months 12
npx tsx scripts/issue-license.ts verify $HOME\.ispm-license\emitidas\LIC-2026-0002.ispmlic
```

**Licença prendida à máquina:** pede o hash no ecrã de licença dele, depois
acrescenta `--bind machine --fingerprint <hash>`.

**Renovar no fim do ano:** emite outra vez, com a mesma referência para o histórico
ficar limpo:
```powershell
npx tsx scripts/issue-license.ts issue --customer "Tony Alves" --id LIC-2026-0002 --months 12
```

**Cliente diz "está registada noutra máquina":** trocou de PC ou renomeou-o. Pede o
hash novo e reemite com a mesma `--id`.

**Cliente pediu mais uns dias para pagar:** `--grace 30` na reemissão dá-lhe 30 dias
de tolerância depois da expiração, em vez de 14.

---

## 10. Notas finais

- `ISPM_LICENSE=off` desliga o licenciamento numa instalação (desenvolvimento e
  testes). `ISPM_LICENSE_PUBLIC_KEY` sobrepõe a chave embebida.
- Uma build com `EMBEDDED_PUBLIC_KEY` vazia comporta-se como se o licenciamento não
  existisse — falha para o lado de deixar trabalhar. Confirma que a chave está lá
  antes de cada release.
- Faz cópia do `private.pem` **e** do `registry.json`. O primeiro é o negócio; o
  segundo é a memória dele.
