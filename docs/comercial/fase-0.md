# Fase 0 — decisões comerciais

O que tem de estar decidido antes da primeira venda. Código não desbloqueia nada
disto. Ver o plano de comercialização e o [ADR 0006](../adr/0006-offline-signed-licensing.md).

Estado: **rascunhos para decidir**, exceto a assinatura de código, onde a
verificação já está feita e o caminho é único.

---

## 1. Assinatura de código — verificado, decidido por eliminação

**Azure Trusted Signing (hoje «Artifact Signing») está fora.** Passou a
disponibilidade geral limitado a empresas dos EUA, Canadá, União Europeia e
Reino Unido, e a indivíduos dos EUA e Canadá. Cabo Verde não consta, e a
Microsoft não anuncia data para outros países. Não é uma questão de preço nem de
tempo de empresa: o registo nem sequer aceita o país.

**Resta um certificado OV de uma AC comercial**, com duas mudanças recentes que
simplificam a decisão:

- Desde março de 2024, o EV **deixou de dar dispensa imediata do SmartScreen**.
  EV e OV constroem reputação da mesma maneira, por volume de downloads. O EV só
  continua a justificar-se para drivers em modo kernel e para clientes
  empresariais cuja política o exija. Não é o teu caso — **compra OV, não EV**.
- Desde 15 de fevereiro de 2026, a validade máxima é de **1 ano**. É uma despesa
  recorrente, não uma compra de três anos.

Ordem de grandeza: **~220 a 390 USD/ano** conforme a AC (Sectigo/Comodo na base,
DigiCert no topo). A chave privada tem de viver em hardware certificado — token
físico ou assinatura na nuvem da AC. **Para assinar no GitHub Actions, escolhe a
opção de nuvem**: um token USB não existe no runner e obrigaria a assinar sempre
à mão.

**Validação da empresa em Cabo Verde:** as ACs verificam a existência da empresa
em registos públicos online. Não havendo registo consultável, aceitam
alternativas — documentos oficiais de constituição, ou uma **carta de parecer
jurídico** («legal opinion letter») de advogado ou contabilista inscrito, em
modelo fornecido pela própria AC. Conta com isto e trata da carta antes de
comprar; é o passo que atrasa a emissão, não o pagamento. Vai ser preciso também
um telefone da empresa verificável numa listagem pública ou por confirmação de
terceiro.

**Integração**, quando o certificado existir: `WIN_CSC_LINK` +
`WIN_CSC_KEY_PASSWORD` como segredos no workflow `desktop-builds.yml`, ou a
integração de assinatura na nuvem da AC escolhida. Nada disto muda a
configuração do `electron-builder` além das credenciais.

**Sequência recomendada:** carta de parecer jurídico → comprar OV com assinatura
na nuvem → assinar → só depois publicar a primeira release paga. Sem assinatura,
o SmartScreen chama malware ao instalador e a primeira impressão de um produto
pago fica arruinada.

Fontes: [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) ·
[disponibilidade fora dos EUA/Canadá](https://github.com/Azure/artifact-signing-action/issues/81) ·
[EV vs OV para instaladores Windows](https://melatonin.dev/blog/how-to-code-sign-windows-installers-with-an-ev-cert-on-github-actions/) ·
[validação de organização Sectigo](https://www.sectigo.com/knowledge-base/detail/OV-Code-Signing-Validation-for-Organizations-and-Individuals)

---

## 2. Preço — a hipótese tem uma incoerência a resolver

Hipótese de partida do plano: perpétua 350.000$00 + 20%/ano de manutenção;
subscrição 15.000$00/mês.

A subscrição a 15.000$00/mês dá **180.000$00/ano**. A perpétua paga-se em menos
de dois anos e depois custa 70.000$00/ano. Nenhum cliente racional que pense
ficar escolhe a subscrição — as duas ofertas competem uma com a outra em vez de
servirem clientes diferentes. A regra habitual é a perpétua valer **2,5 a 3×** a
anuidade da subscrição. Duas saídas coerentes:

| Saída | Subscrição | Perpétua | Rácio |
|---|---|---|---|
| Baixar a subscrição | 10.000$00/mês (120.000$00/ano) | 350.000$00 + 70.000$00/ano | 2,9× |
| Subir a perpétua | 15.000$00/mês (180.000$00/ano) | 500.000$00 + 100.000$00/ano | 2,8× |

Âncora externa: o **Splynx**, a referência internacional para ISPs pequenos,
começa em **~255 USD/mês** (≈ 28.000$00) até 400 subscritores, alojado na nuvem,
em inglês e sem nada de fiscalidade cabo-verdiana. Uma subscrição a 10.000–15.000$00
fica claramente abaixo, o que é defensável — mas mostra que o teto não é tão
baixo como parece.

Aferição pelo lado do cliente: um ISP com 200 clientes a 2.500$00/mês factura
500.000$00/mês. 15.000$00 são **3%** da receita — aceitável para o sistema que
gere o negócio inteiro, mas apertado abaixo de ~120 clientes. Se quiseres vender
a operadores mais pequenos, é aí que faz sentido um escalão de entrada, não
feature-flags.

**A decidir por ti**, depois de falar com 2–3 prospects reais: qual das duas
saídas, e se existe escalão de entrada por dimensão. Nada disto exige código: o
preço não está no produto, está na licença que emites.

---

## 3. Política de suporte — rascunho de uma página

Preencher os contactos e publicar. É referida na cláusula 10 do EULA.

**Canais.** WhatsApp [NÚMERO] e email [EMAIL]. O WhatsApp é o canal principal —
é onde os clientes já estão.

**Horário.** Dias úteis, 8h30–17h30 (hora de Cabo Verde). Fora deste horário, só
incidentes críticos.

**Tempos de resposta** (resposta, não resolução):

| Severidade | O que é | Resposta |
|---|---|---|
| Crítico | A aplicação não abre, perda ou corrupção de dados, faturação parada | 4 horas úteis |
| Normal | Função com defeito mas com alternativa; dúvida de utilização | 1 dia útil |
| Melhoria | Pedido de funcionalidade nova | Sem compromisso de prazo; entra na lista |

**Incluído:** correção de defeitos, atualizações, dúvidas de utilização,
reemissão de licença por mudança de máquina, ajuda a recuperar uma cópia de
segurança.

**Não incluído** sem orçamento à parte: deslocações, formação para além da
sessão inicial, migração de dados de outro sistema, relatórios ou
funcionalidades por medida, configuração de rede ou de equipamentos.

**O que o cliente tem de fazer:** manter as cópias de segurança automáticas
ativas e guardar periodicamente uma cópia fora do computador. Suporte a perda de
dados sem cópia é recuperação, não suporte, e é orçamentada.

---

## 4. Faturação própria

Antes da primeira fatura emitida por ti, e não por adiar: escolher o regime
(REMPE vs Normal), garantir emissão de faturas conformes e o registo na
plataforma de fatura eletrónica. Vender software de gestão a operadores e não
conseguir emitir a própria fatura em condições é o tipo de detalhe que se paga
caro na primeira venda a uma empresa organizada.

Consequência direta no EULA: a cláusula 11.2 diz que o ISPM **não é** um
programa de faturação certificado. Se algum dia o for, essa cláusula muda — e
passa a ser argumento de venda, não ressalva.

---

## 5. EULA

Está escrito em `assets/license_pt_PT.txt` e o `electron-builder` já o mostra no
instalador (ficheiro detetado automaticamente nos *build resources*, convertido
para UTF-8 com BOM; não precisou de configuração).

**Antes de publicar, preencher os campos entre parênteses retos:** denominação
social, NIF, morada, comarca, contactos, data de entrada em vigor e endereço da
política de suporte.

**Revisão por advogado em Cabo Verde antes da primeira venda.** O texto está
estruturado e é coerente com o produto — em especial a cláusula 8.2, que promete
por contrato aquilo que o código garante: uma licença caducada nunca tranca o
cliente fora dos dados dele. O que não posso garantir é a conformidade com o
direito cabo-verdiano, sobretudo nos limites de responsabilidade (cláusula 14) e
nas garantias (cláusula 13), onde a lei local pode impor mínimos imperativos.
