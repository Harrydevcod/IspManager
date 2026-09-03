# Changelog

Todas as versões notáveis do ISPM. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e cada versão tem uma [Release no GitHub](https://github.com/Harrydevcod/IspManager/releases) com o instalador correspondente.

**Numeração — a partir da 2.0:** as versões dizem-se com **dois números** (2.0, 2.1, 2.2). Não há versões de correção: um problema urgente sai como a minor seguinte, não como 2.0.1. O `package.json`, o `latest.yml` e as comparações do auto-update continuam a usar três números com o terceiro sempre a zero (`2.0.0`, `2.1.0`), porque o [Versionamento Semântico](https://semver.org/lang/pt-BR/) exige três e uma versão inválida parte a atualização automática em silêncio. Onde o número é lido por pessoas — este ficheiro, a etiqueta, o título da release e o ecrã Sobre — usam-se dois.

## Por lançar

## [1.21.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.21.0) — 2026-09-03

### Corrigido

- **"Zonas mais rentáveis" agrupa pela zona do cliente, não pela etiqueta do investimento.** O painel somava o lucro dos investimentos pela zona escrita na ficha do investimento, e essa etiqueta não diz onde vivem os clientes que ele serve: uma antena etiquetada "Cruz" servia clientes de catorze zonas. Os investimentos sem zona caíam todos num balde "Sem zona" que levava dois terços do lucro mensal da empresa — não eram zonas a competir, era o total repartido por uma etiqueta. Agora a zona é a do cliente: receita de caixa da zona menos o OPEX rateado por serviço ativo, sobre um mesmo intervalo de meses para todas (por intervalo próprio, a zona com um só mês de recibos parecia render o dobro da que cobra há um ano).

### Alterado

- O cartão das zonas passa a mostrar o número de clientes e a decomposição da conta (receita menos OPEX), para se ler sem abrir o código.

### Adicionado

- `scripts/normalize-zones.cjs` — acerta as zonas dos clientes a uma lista fechada. Os campos Zona e Morada tinham sido usados um pelo outro e metade das "zonas" eram pontos de referência dentro de outra. Simulação por omissão; `--apply` escreve.

## [1.20.2](https://github.com/Harrydevcod/IspManager/releases/tag/v1.20.2) — 2026-09-03

### Corrigido

- **Uma entrada de stock deixa de poder ser negativa.** É a irmã da regra do custo que foi na 1.20.1, e diz a mesma coisa por outro lado: só a compra é capital, e uma compra tem sinal e preço. Uma entrada de quantidade negativa não é compra nenhuma — é uma correção de contagem com o tipo trocado, e desde que o capital passou a somar as entradas, subtrairia dinheiro que nunca se gastou. Aconteceu duas vezes na base, salvas por acaso de terem o custo a zero. O formulário passa a recusá-la e a dizer que o caminho é **Ajuste**

### Notas

- **A ferramenta de reconciliação mudou de nome e faz mais.** Passou a `scripts/reconcile-capital-history.cjs`, porque já não é só ligar itens ao catálogo: além disso, põe preço nas compras que entraram com o custo em branco (**39.325$** na base atual — 115 metros de cabo, 3 CPE 510, um Archer C20, um MW325R, um repetidor e 20 RJ45, nenhum com fornecedor nem referência), e reclassifica como ajuste as duas entradas negativas que as próprias notas diziam ser acertos. Continua em simulação por omissão, e ou o lote todo confere ou não toca em nada
- **Sobre os 435 metros de cabo que pareciam faltar ao armazém:** foram usados, e não há nada a corrigir. Só 8 dos 30 serviços têm cabo lançado, e todos de junho de 2026 em diante — os outros 22 são anteriores ao sistema e foram importados sem detalhe de material. À média de 21,25 m dos registados, esses 22 dão 467 m, que explica a diferença. É o mesmo caso da caixa importada: o histórico é mais fino do que a realidade, e lançar as linhas agora seria inventar metragens que ninguém mediu


## [1.20.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.20.1) — 2026-09-03

### Corrigido

- **Registar uma compra sem preencher o custo deixa de a enterrar.** Foi um efeito da própria 1.20: enquanto o capital se deduzia do saldo do armazém, o custo do movimento era decorativo e ficar a zero não fazia mal a ninguém. Desde que o capital passou a ser a soma das entradas, uma compra sem custo desaparece — o stock sobe, o dinheiro que saiu da conta nunca aparece em lado nenhum, e nada o diz. Não é hipotético: há **115 metros de cabo** na base que entraram assim, e é por isso que o cabo aparece com 3.300$ de capital quando se pagaram 33.551$ por 610 metros. A partir daqui a entrada exige o custo, nos dois caminhos que criam uma compra — o movimento de stock e o formulário do modelo, seja ele a nascer com stock ou a ver o stock subir. **Saídas e ajustes não mudam:** só a compra é capital, e descer o stock é uma correção de contagem, que não custa nada

### Notas

- **Ferramenta nova, para quem tem histórico por reconciliar.** `scripts/reconcile-capital-history.cjs` liga ao catálogo os itens de investimento que são o mesmo equipamento que já deu entrada no armazém — o que a 1.20 tornou possível mas deixou por fazer no histórico. Corre em simulação por omissão e só escreve com `--apply`; ou o lote todo confere, ou não toca em nada. Na base atual tira **305.700$** de dupla contagem, de oito dos treze itens. Os cinco que ficam de fora estão explicados no cabeçalho do próprio script: cabo e RJ45 porque o armazém só conhece uma parte do que se comprou e ligá-los apagaria capital real; as serrilhas porque são custo externo genuíno; e o router de gestão porque é o aparelho da operadora, que não é o mesmo que os MikroTik dos clientes


## [1.20.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.20.0) — 2026-09-03

### Corrigido

- **O capital deixa de crescer sozinho de cada vez que um equipamento volta ao armazém.** O "Total investido" era calculado a partir do stock em mãos mais tudo o que já tinha saído — uma conta que só está certa se uma unidade que sai nunca lá voltar. Volta: devolução, transferência de titular, troca de equipamento avariado, retirada de backbone. Cada regresso repunha o stock sem apagar a saída que lhe deu origem, e a mesma antena passava a contar duas vezes, **para sempre**. Na base atual estavam **42.500$ contados a dobrar**, de 8 devoluções, a inflar o capital e a afundar a Caixa acumulada na mesma medida. A partir daqui o capital é a soma das **compras**: uma devolução não é uma compra, logo não conta, e o erro não pode voltar
- **O gráfico e o cartão deixam de contar histórias diferentes sobre o mesmo dinheiro.** O gráfico de capital por ano mostrava só os investimentos lançados à mão — o equipamento comprado não aparecia em ano nenhum, porque o capital era deduzido do saldo do armazém e um saldo não tem data. Agora cada compra fica com o dia em que saiu da conta, e a soma do gráfico bate exatamente com o cartão
- **Guardar um modelo no catálogo deixa de apagar o transporte, a alfândega e os outros custos.** O formulário não mostrava esses três campos nem os enviava, e o servidor, ao não os receber, punha-os a zero: bastava corrigir o preço de venda de um modelo para o custo real de o pôr em armazém encolher em silêncio — e com ele o capital de tudo o que fosse instalado a seguir. Passam a ser preservados. A descrição sofria do mesmo e também fica

### Adicionado

- **A carteira, em Financeiro › Lucro.** Por cliente: o capital que levou em equipamento, material e mão de obra, quanto já devolveu em pagamentos, a margem que dá por mês e quanto falta para deixar de dar prejuízo. Entra ordenada por quem tem mais por recuperar, porque é essa a lista de que se tomam decisões — quem cortar, a quem não voltar a instalar, que zona não compensa. A conta já existia, mas só dentro da ficha de um cliente de cada vez, o que não deixa comparar ninguém. A ficha passa a ler o número desta mesma conta, para as duas não poderem discordar
- **Parque instalado**, ao lado da caixa e com nome próprio. A Caixa acumulada responde a "quanto dinheiro tenho" e abate o capital todo no mês em que sai da conta — continua exatamente assim. O parque responde à outra pergunta: **quanto vale hoje o que já está nos telhados**, e quanto se desgasta por mês. Cada modelo tem uma vida útil no catálogo (cinco anos por omissão, editável — uma bateria não dura o que dura um switch), e é ela que dilui o custo do equipamento ao longo do tempo em vez de o fazer pesar todo no mês da instalação. É esse desgaste que a margem mensal da carteira desconta, e é por isso que a margem de um cliente instalado o mês passado se pode comparar com a de um instalado há três anos
- **O item de um investimento pode apontar para um modelo do catálogo.** Escrevendo o nome do modelo na linha do item, o sistema reconhece-o e o custo desse equipamento deixa de somar outra vez: ele já contou quando deu entrada no armazém, e o investimento passa a **agrupá-lo** em vez de o pagar duas vezes. Quem comprasse seis CPE e depois registasse o investimento "Expansão Achada" pagava-os a dobrar no relatório, e nada no sistema o dizia. Linhas que não são equipamento — mão de obra, poste, licença, aluguer de grua — continuam a somar como sempre

### Alterado

- **Entrar stock pelo formulário do modelo passa a deixar rasto.** Escrever um número no campo Stock era a única forma de mexer no armazém sem registo: não ficava nem quantidade, nem custo, nem data. Agora subir o stock regista uma **compra** e descer regista uma **correção de contagem** — coisas diferentes, e só a primeira é capital. O histórico do artigo mostra as duas

### Notas

- **A migração 0053 mexe no histórico, e foi medida antes.** Como o formulário do catálogo nunca deixou rasto das compras, o capital de tudo o que entrou por lá não existe em lado nenhum com custo e data. A migração lança essa abertura de inventário — **106 unidades em 10 modelos**, na base atual — valorizadas ao custo médio das saídas de cada modelo, que é o que se pagou no dia da instalação, e não ao preço de hoje. Correu-se sobre uma cópia da base real antes de sair. Faça na mesma o backup antes de instalar
- **Os investimentos antigos continuam a contar como estão.** Os 13 itens de investimento já lançados não apontam para o catálogo, porque essa ligação não existia quando foram escritos: até serem revistos um a um, equipamento que esteja registado nos dois sítios ainda soma duas vezes. Quem os lançou é quem sabe quais são — abrir o investimento e reescrever o nome do item para o do modelo é o que os liga

## [1.19.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.19.0) — 2026-08-30

### Corrigido

- **O Lucro passou a ver o dinheiro que entra aos bocados.** A aba Financeiro › Lucro somava faturas fechadas: uma fatura de 50.000$ com 10.000$ já entregues contava **zero** — no lucro acumulado, no ROI de cada investimento e no rateio de receita por zona — até ao dia em que fechasse, e nesse dia contava 50.000$ de uma vez. Agora conta os recibos, como o painel de entrada já fazia desde a 1.18: o dinheiro pesa quando entra, e pesa o que entrou. Recibo anulado deixa de contar; fatura liquidada por conta corrente não conta segunda vez, porque esse dinheiro já contou quando entrou
- **A receita cai no mês em que o dinheiro entrou**, não no mês que a fatura cobre. Com faturação pós-paga a mensalidade de abril é quase sempre cobrada em maio: a linha de recuperação de cada investimento mostrava-a em abril, um mês antes de o dinheiro existir. As linhas do tempo dos investimentos e a data de recuperação deslocam-se em conformidade — no parque atual, 246.500$ dos 260.500$ recebidos mudam de mês na leitura, quase tudo o desfasamento normal de um mês
- **O PDF e o Excel de rentabilidade diziam outro número.** Calculavam o lucro a partir da receita **esperada** do investimento e de uma coluna de receita acumulada preenchida à mão, enquanto o ecrã usava os pagamentos reais: dois valores com o mesmo nome e nenhuma forma de saber qual valia. Passam a usar a mesma conta do ecrã, e o Excel ganha a coluna **Receita real/mês** ao lado da esperada

### Alterado

- O indicador **"Lucro acumulado"** da aba Lucro passa a chamar-se **"Caixa acumulada"**, que é o que sempre foi: recebido menos todo o capital aplicado menos as despesas. Um investimento de 500.000$ afunda o mês em que é feito — isso é caixa, não prejuízo. O lucro mensal de cada investimento (receita menos OPEX) não mudou de nome nem de conta

## [1.18.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.18.0) — 2026-08-29

### Adicionado

- **O cliente pode pagar aos bocados.** A fatura era tudo-ou-nada: quem entregava 10.000$ de 50.000$ não tinha onde ser registado — ou se marcava a fatura como paga, o que é mentira, ou o dinheiro ficava fora do sistema. Agora cada entrada de dinheiro é um registo próprio, com o **seu número de recibo**, data e método, e a fatura fecha sozinha quando a soma a cobre. Quem entrega 10.000$ leva hoje a prova dos 10.000$, não no dia em que acabar de pagar. Na lista, a fatura meio paga mostra o que falta em destaque e o que já entrou por baixo; o estado diz **Parcial** — mas se já passou o prazo continua a dizer **Em atraso**, que é a verdade que interessa primeiro. O valor da fatura não se toca: nasce com o documento numerado e fica
- **Financeiro › Pendentes**, a vista de cobrança. Responde à pergunta que o módulo de Pagamentos, organizado por fatura, não responde: **quem deve, quanto, e há quanto tempo**. Dívida por cliente com a antiguidade em intervalos (por vencer, 1-30, 31-60, 61-90, mais de 90 dias), o total em aberto, o vencido, e o crédito em circulação. O intervalo de um cliente é o do seu **dia mais atrasado**: quem tem uma fatura de há 120 dias e outra de ontem aparece no "mais de 90", que é o problema real. Clicar numa linha abre a ficha do cliente
- **Conta corrente do cliente.** Quem paga a mais não leva erro: o excesso fica-lhe a favor e **abate-se sozinho na fatura seguinte**. Anular uma fatura que já tinha recebido dinheiro devolve-o à conta corrente em vez de o engolir — e é por isso que reemitir uma fatura corrigida depois de anular uma paga faz a nova **nascer já liquidada**: o cliente entregou o dinheiro, o erro foi nosso, cobrar outra vez é que era o defeito. O crédito aparece na ficha do cliente e no painel de Pendentes
- **Anular um recebimento mal lançado**, com motivo obrigatório. O clássico é o 100.000$ onde eram 10.000$. O número do recibo **fica na série, anulado** — não se recicla nem desaparece — e a fatura reabre com o saldo em dívida se era esse recibo que a fechava

### Corrigido

- **Os painéis deixam de confundir o que entrou com o que falta.** Com recebimentos parciais a mesma fatura tem dinheiro de um lado e dívida do outro, e somar o valor cheio dos dois lados inflava tudo. A receita por regime de caixa (painel, operação, relatórios) passa a contar **os recibos**, com a granularidade certa: 10.000$ entregues em julho pesam em julho, e não zero até ao dia em que a fatura fechar. Tudo o que é dívida passa a contar o **saldo** — incluindo o aviso automático de WhatsApp, que mandava o valor cheio da fatura a quem já tinha pago metade
- **A data de instalação, troca e recolha vem do formulário.** O equipamento instala-se hoje e regista-se amanhã; até aqui, o que ficava gravado era o dia do registo — na base, dezenas de equipamentos têm a data do carregamento inicial em vez da real. Agora atribuir, substituir e recolher perguntam o dia, e a data escolhida viaja para o histórico do artigo e para a linha do tempo do cliente. O `created_at` continua a marcar quando foi lançado: facto e registo são coisas diferentes. A data de um equipamento já registado corrige-se na edição, com registo de auditoria. Recusa-se o que não faz sentido no tempo — datas futuras, instalações anteriores à ativação do serviço, recolhas anteriores à instalação
- **A substituição de equipamento deixa de apagar a renda e a unidade retirada.** O atalho "Substituir", lançado na 1.17, escrevia a atribuição nova à mão e esquecia a propriedade e o aluguer: a mensalidade do equipamento caía para zero na primeira troca. E fechava a antiga sem estado, pelo que a unidade não voltava ao armazém nem ficava registada como avariada. Uma troca é uma devolução mais uma instalação, e passa a usar os dois motores que já existiam. O formulário pergunta em que estado voltou a unidade retirada — só em bom estado regressa ao stock
- **Equipamento no backbone deixa de aparecer como disponível.** Uma antena registada no backbone está num poste, não no armazém, mas o Stock continuava a oferecê-la: o registo de backbone era o único caminho que tirava equipamento sem lhe dar baixa. Passa a dar: registar consome uma unidade, retirar devolve-a, e não se regista backbone de um modelo esgotado. A migração 0050 acerta as unidades já instaladas e deixa o acerto visível no histórico do artigo, em vez de mexer no número em silêncio. Na coluna Stock, os modelos com unidades no terreno dizem quantas

### Notas

- **A migração 0052 mexe no histórico, e foi medida antes.** Para os totais de caixa não perderem o passado, cada fatura já paga passa a ter o recibo que a saldou. Correu-se sobre uma cópia da base real: **93 faturas pagas deram 93 recibos**, 260.500$ de um lado e do outro, zero divergências. Faça na mesma o backup antes de instalar
- **A conta corrente é nova no terreno.** Nunca houve crédito de cliente no sistema: a partir desta versão, um pagamento a mais não dá erro — fica a favor do cliente e abate-se na fatura seguinte. Convém dizê-lo a quem lança os pagamentos, antes de o encontrarem sozinhos

## [1.17.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.17.0) — 2026-08-28

### Adicionado

- **descoberta:** o campo **"Intervalo"** passa a dizer **quantos endereços vai varrer, antes de varrer**: "254 endereços", "1 endereço — varre um só", ou a razão a vermelho quando o que lá está não é um intervalo válido. Um endereço solto continua a ser aceite — às vezes quer-se picar um só — mas deixa de o ser em silêncio. O campo guarda-se entre sessões, e `192.168.1.37` tem exatamente o mesmo aspeto que `192.168.1.1-254` dentro de uma caixa de texto: a diferença só aparecia depois de carregar em Varrer, com a barra a piscar uma vez e a tabela a vir com uma linha
- **descoberta:** a proposta **"Modelo diferente do registado"** deixa de ser um beco. Onde estava um crachá cinzento a dizer "em Serviços" está agora o botão **"Substituir em Serviços"**, que abre o serviço certo com o diálogo **Substituir equipamento** já aberto **no equipamento daquela linha** — em vez de obrigar a sair da aba, abrir Serviços, procurar o cliente, abrir o serviço e encontrar a linha à mão. A troca continua a fazer-se onde sempre se fez, com as validações e o movimento de stock de lá: o botão abre a porta, não passa por cima dela. Se o equipamento já não estiver lá, ou a permissão não chegar, não abre nada e fica-se no serviço em foco — nunca se abre por atalho um diálogo que ninguém conseguiria abrir à mão
- **descoberta:** **"Backbone sem resposta"** ganha o mesmo tratamento com **"Abrir no Backbone"**. O crachá que lá estava dizia "em Serviços", que é falso — um backbone não tem serviço. Um modelo diferente num equipamento de backbone também vai agora para o separador certo

### Corrigido

- **descoberta:** o nome que a varredura já resolvia **deixa de se perder**. O DNS inverso corria a cada endereço vivo, em cada varrimento, e o resultado era deitado fora a caminho do ecrã. Passa a preencher a coluna "Nome" — mas só onde não há nada: o nome que o equipamento tem configurado e o que ele anunciou ao pedir endereço continuam a ganhar-lhe, e este não se guarda na base, porque uma entrada de DNS que alguém criou e pode não ter apagado não merece ficar lá para sempre

### Notas

- **Porque é que a app da Starlink sabe o nome e o modelo de tudo e o ISPM não sabe de todos:** ela não descobre nada — pergunta ao router, que é ao mesmo tempo o servidor DHCP, o ponto de acesso e o gateway, e portanto já tem as tabelas todas. O ISPM faz o mesmo com o MikroTik de gestão, quando está configurado. Faltava o mDNS/Bonjour, e **mediu-se antes de construir**: com 43 equipamentos vivos, responderam 1 em 43 — e esse anunciou uma televisão. Na Starlink os clientes são telemóveis e portáteis, que se anunciam sozinhos; aqui são CPE e antenas, que não falam. O canal fica medido e **não foi implementado**. As sondas ficam no `scripts/probe-models.cjs`, para o dia em que o parque mude

## [1.16.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.16.0) — 2026-08-27

### Adicionado

- **descoberta:** a varredura passa a dizer **que aparelho é** cada endereço, não só de que marca. A coluna "Fabricante" dá lugar a **"Equipamento"**, que mostra o modelo quando se sabe e o fabricante quando é tudo o que há. O modelo vem de três sítios, por ordem de confiança: do **registo do ISPM** (o equipamento que já foi registado por alguém que o teve na mão), dos **vizinhos do router de gestão** (quem se anuncia por MNDP/CDP/LLDP), e de **perguntar ao próprio equipamento**. Por baixo do modelo fica escrito de onde veio. Medido no parque real: **26 dos 42 equipamentos vivos** ficam identificados — os CPE da TP-Link pelo modelo exato (CPE510, CPE710), os switches pela referência (TL-S5-5KM), e o router da Starlink. Quem não responde o suficiente continua a mostrar só o fabricante, em vez de uma etiqueta inventada
- **descoberta:** quando o modelo registado **não bate certo** com o que o equipamento responde na rede, a linha fica a laranja e diz **o que a rede respondeu** (`rede: TL-CPE500`). Quase sempre quer dizer que o aparelho foi trocado no terreno e ninguém atualizou o sistema
- **descoberta:** interruptor **"Identificar modelos"**, ao lado do do router. **Desligado por omissão**: é o único caminho da aba que sai do ping e vai bater à porta do equipamento do cliente. Ligado, a identificação corre a seguir à varredura e vai enchendo a tabela à medida que as respostas chegam. O CSV exportado leva o modelo e a origem
- **descoberta:** a varredura passa a poder **escrever no registo**, sempre por proposta e nunca sozinha. Uma secção **"Aplicar ao registo"** mostra o que a rede sabe e o sistema ainda não — MAC por preencher, endereço mudado, modelo diferente do registado — cada linha com o antes e o depois lado a lado, e um botão para aplicar ou dispensar. Aplicar usa as mesmas rotas de sempre, com as mesmas validações: a Descoberta não abre uma segunda porta para o registo
- **descoberta:** o casamento entre registo e rede passa a fazer-se **pelo MAC primeiro**, e só pelo endereço quando não há MAC. Os routers dos clientes apanham IP por DHCP: desligar e religar um deles troca-lhe o endereço, e a partir daí casar por endereço apontava para o equipamento errado. Quando o endereço muda, a proposta que aparece é "endereço diferente", com o aparelho reconhecido na mesma
- **descoberta:** registar equipamento encontrado deixa de ser escrever tudo à mão. O "Registar como backbone" leva já o endereço, o MAC, o nome anunciado e o **item do catálogo escolhido pelo modelo detetado**; e há um **registo em lote** para várias antenas do mesmo modelo de uma vez. Só entram no lote os que responderam um modelo — fabricante sozinho é quase sempre um telemóvel
- **descoberta:** equipamento registado sem endereço nem MAC aparece como "sem identidade na rede", com uma lista curta de candidatos do mesmo fabricante para escolher. Quando os candidatos são muitos a lista cala-se: uma sugestão que não estreita nada só ensina a ignorar as que estreitam

### Corrigido

- **interface:** espaçamentos e cores que estavam a colapsar em silêncio por toda a aplicação. Quarenta e três declarações de CSS apontavam para variáveis que não existem — e uma variável inexistente não dá erro, a regra é simplesmente descartada. Afetava a Descoberta, os Planos, o Financeiro, o Backbone, as OS técnicas e a importação de clientes: painéis apertados, ênfases que não se viam e um aviso do Backbone sem a cor de aviso
- **interface:** os cartões de indicadores deixam de deixar um vazio grande à direita. A grelha tinha um número de colunas fixo — cinco — independentemente de haver quatro cartões ou um só; passa a acompanhar quantos são. Nota-se sobretudo nos Investimentos, nas Despesas e na Descoberta

## [1.15.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.15.0) — 2026-08-26

### Adicionado

- **stock:** o **tipo de equipamento** deixa de ser uma lista fechada. No formulário há **"+ Novo tipo…"**, que troca a lista por uma caixa de texto para escrever o que faltar — o tipo passa a existir a partir daí e reaparece na lista e no filtro. Escrever um que já exista com outra caixa adota o existente, em vez de criar um gémeo. Antes, um equipamento que o vocabulário não previsse obrigava a esperar por uma versão nova da aplicação
- **stock:** **Ponto de Acesso** e **Repetidor WiFi** juntam-se aos tipos de fábrica, com ícone próprio
- **serviços:** o ecrã de atribuição em massa passa a ser **"Identificar equipamentos"** e ganha a coluna **MAC** ao lado do IP, com um filtro **"Por identificar"** que lista o equipamento sem MAC nem número de série. É onde se regista de uma vez o parque que está no terreno sem identidade

### Alterado

- **rede:** o **IP fixo** passa a ser escolha da instalação, não do tipo de equipamento. O campo aparece em todo o equipamento e deixá-lo vazio significa DHCP; o CPE e a antena continuam a pedir endereço, porque são o que aponta ao backbone. Antes, um router de gestão ou um ponto de acesso não conseguiam receber endereço — o campo nem aparecia — e não apareciam no ecrã de atribuição
- **topologia:** o aviso **"Configuração incompleta"** passa a **"Sem série nem MAC"** e só acusa quem não tem nenhuma das duas identidades. Antes exigia número de série, e marcava praticamente todo o parque
- **operação:** o painel do Estado da operação mede a identificação do parque por **MAC ou série**, a mesma regra do resto da aplicação

### Corrigido

- **equipamento:** o **MAC** passa a ser validado e único entre equipamentos ativos, e é guardado sempre na mesma forma (`AA:BB:CC:DD:EE:FF`), venha escrito com dois-pontos, hífenes ou sem nada. Antes gravava-se qualquer texto e dois equipamentos podiam ficar com o mesmo MAC sem ninguém dar por isso
- **topologia:** o aviso de **IP em falta** deixa de acusar os routers de cliente, que apanham endereço por DHCP por desenho
- **stock e serviços:** o tipo do equipamento era mostrado em cru (`repetidor`) na tabela do stock, no detalhe do serviço e no inspetor da topologia, em vez do nome

## [1.14.3](https://github.com/Harrydevcod/IspManager/releases/tag/v1.14.3) — 2026-08-25

### Adicionado

- **interface:** o **botão direito** passa a abrir menu. Em campos de texto dá Anular, Refazer, Cortar, Copiar, Colar e Selecionar tudo, com os comandos desativados quando não se aplicam; sobre texto selecionado fora de um campo dá Copiar. Antes não fazia nada em lado nenhum da aplicação

### Corrigido

- **interface:** **copiar texto fora dos campos de formulário** — o IP numa lista, o serial numa ficha, o valor numa tabela. Na lista de Serviços nem selecionar era possível; nas restantes listas o texto selecionava-se, mas o clique que fecha o arrasto abria o detalhe por cima da seleção. Agora arrastar sobre o texto selecciona e não abre nada; o clique simples continua a abrir a linha, e o teclado (Enter/Espaço) também

## [1.14.2](https://github.com/Harrydevcod/IspManager/releases/tag/v1.14.2) — 2026-08-24

### Corrigido

- **stock:** registar equipamento **do cliente** continuava a exigir stock do artigo. A 1.14.1 tirou-lhe o desconto de inventário, mas as guardas que pedem stock corriam antes de olhar à propriedade — e com o artigo a zero, que é o caso normal de um router que o cliente comprou ou herdou da operadora anterior, o registo era recusado com *"Stock insuficiente"*. A única saída era inventar unidades no armazém, exatamente o que a versão anterior tinha ido corrigir. Agora a exigência de stock aplica-se **só a equipamento do ISP**, e no formulário escolhe-se **Propriedade → Do cliente** para a lista abrir com os artigos a zero disponíveis

## [1.14.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.14.1) — 2026-08-24

### Corrigido

- **stock:** registar um equipamento como **do cliente** — o router que ele comprou, ou herdou da operadora anterior — descontava uma unidade do armazém e escrevia um custo de aquisição que a empresa nunca teve. Com os artigos de router a zero, o registo seguinte punha o inventário negativo. A devolução tinha o erro espelhado: repunha stock de uma unidade que nunca lá esteve. Passa a valer a regra simples — **equipamento do cliente nunca toca em inventário**, nem ao instalar nem ao devolver. A troca física continua a descontar, porque aí a unidade nova é sempre do ISP

## [1.14.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.14.0) — 2026-08-24

Uma versão sobre o que acontece ao **equipamento** quando um cliente sai, muda de casa ou é substituído por outro. Tudo o que era feito à mão na base de dados — ou não era feito de todo — passa a ter um caminho com registo, auditoria e efeito certo na fatura.

### Adicionado

- **equipamento:** ao **cancelar um serviço** abre-se o painel de **devolução**: marca-se o que voltou e em que estado. Só o que volta em **bom estado** regressa ao stock — avariado ou não devolvido fica registado como perda, com o custo onde já estava. O material recupera-se parcialmente, nunca mais do que o que foi consumido. O aluguer pára em todos os casos, a partir da mensalidade seguinte
- **serviços:** **transferir o titular** de um serviço, para um cliente novo ou para um que regressa. O histórico de faturação **não se move** — quem foi faturado foi faturado. No modo *fica no mesmo local* mantém-se equipamento, IP e antena; no modo *recolhido e reinstalado* liberta-se o IP, fecha-se a ligação à antena antiga e geram-se novas credenciais PPPoE, porque o inquilino anterior conhece as antigas
- **equipamento:** **passar a titularidade de uma antena partilhada** a um dos serviços que ela já serve — o prédio com uma antena e um switch, ou as casas coladas. Quando o titular saía, a antena ficava órfã: a devolução era recusada e a única saída era desassociar os vizinhos à mão. Agora promove-se um deles, dos dois lados (*Passar titularidade* no titular, *Assumir antena* no vizinho), sem baixa de stock nem reinstalação: a renda passa a sair na fatura do novo titular e o destino do titular antigo é escolha explícita do operador

### Corrigido

- **faturação:** um serviço **suspenso** que ficou com o equipamento do ISP em casa deixava de ser faturado por inteiro — incluindo a **renda do equipamento**, que continua a ser devida enquanto a unidade não voltar. O suspenso passa a pagar só a renda, e a previsão de receita espelha o que é realmente faturado

## [1.13.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.13.0) — 2026-08-17

### Adicionado

- **equipamento:** o **aluguer de um equipamento já instalado** passa a corrigir-se no diálogo de editar equipamento. A renda nasce copiada do catálogo na instalação e fica congelada na atribuição — é isso que faz uma fatura antiga continuar a valer o que valia —, mas até agora não havia forma nenhuma de a acertar depois. O campo só aparece em equipamento do ISP, vale a partir da fatura seguinte, e o antes e o depois ficam na auditoria
- **manutenção:** `scripts/align-rentals-to-catalog.cjs` acerta em bloco o aluguer do parque instalado ao preço do catálogo, para quando o preço muda. Simula por omissão, escreve com `--apply`, só toca em equipamento instalado e do ISP, e deixa rasto na auditoria

### Corrigido

- **planos:** o diálogo de **aplicar o preço aos serviços ativos** comparava o total novo com o valor **inteiro** da última fatura. Como o audiovisual viaja na mesma fatura, quem o tem via anunciada uma descida do tamanho do audiovisual que não existe — esse valor continua a ser cobrado por cima. Passa a comparar com a linha de internet, e a coluna chama-se **Última mensalidade**

## [1.12.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.12.0) — 2026-08-17

### Adicionado

- **faturação:** o **aluguer do equipamento** passa a ser cobrado por linha própria na mensalidade, em vez de estar embutido à mão no preço. Cada equipamento instalado que seja do ISP soma a sua renda ao plano, e a fatura mostra o que é o quê
- **equipamento do cliente:** um equipamento pode agora ser **do cliente** — porque ele o trouxe, ou porque o comprou. Nesse caso não gera renda nenhuma e a linha desaparece da fatura seguinte. A compra fica registada com data e valor, e emite a cobrança correspondente (preço sugerido pelo catálogo, editável; a zero passa a ser dele sem faturar nada)
- **planos:** botão **aplicar o preço aos serviços ativos**. O valor mensal de cada serviço é copiado do plano quando o serviço é criado, por isso mudar o preço do plano nunca alterava quem já lá estava. Antes de aplicar mostra, cliente a cliente, a última fatura, o aluguer e o valor novo — e quantos sobem, descem ou ficam iguais
- **rede:** nova aba **Descoberta** na Topologia — varre um intervalo de endereços e cruza o que encontra com o que o ISPM já sabe. Responde às quatro perguntas que um scanner sozinho não responde: **quem está na rede sem estar registado**, **que equipamento registado deixou de responder**, **que IP está atribuído a dois serviços ao mesmo tempo** e **qual é o próximo endereço livre** para a instalação seguinte. Junta três fontes — o ping, a tabela ARP da máquina e, quando está configurado, o ARP e as concessões DHCP do router de gestão — e mostra MAC, fabricante e desde quando cada equipamento é visto na rede
- **rede:** o router da operadora passa a chamar-se **router de gestão do ISP** em toda a interface. Há clientes com MikroTiks próprios em casa e esses aparecem na descoberta como equipamentos quaisquer — o ISPM liga-se apenas ao router configurado nas Definições, nunca a equipamento de um cliente
- **rede:** sobre cada endereço encontrado dá para abrir a interface web do equipamento, registá-lo como backbone com o IP e o MAC já preenchidos, atribuí-lo ao equipamento instalado de um serviço, ou exportar a lista em CSV
- **rede:** o fabricante vem do registo oficial de OUI do IEEE (39.935 prefixos, gerados por `scripts/fetch-oui.cjs` e incluídos na aplicação — nunca é consultado online). Telemóveis e portáteis modernos usam endereços aleatórios e ficam sem fabricante, que é o que são
- **rede:** um endereço só entra nos **livres** quando o registo que o ocupa for libertado — retirar o equipamento, limpar o IP, abater o backbone. O CPE de um cliente suspenso continua instalado em casa dele: não responde porque está cortado, e aparece como **Reservado**, nunca como livre. Dar esse endereço a outra instalação seria um conflito no dia em que o cliente pagar
- **rede:** a lista ordena-se por endereço ou por estado, e por estado é por urgência — desconhecido, duplicado, sem resposta, reservado, registado
- Só ICMP: a ferramenta não varre portos nem procura partilhas. Cada varrimento fica registado na auditoria com o intervalo e o autor

### Notas de migração

> **Importante — a ordem interessa.** O aluguer entra em vigor assim que esta versão arrancar. Enquanto os serviços tiverem o valor mensal antigo, a próxima fatura será *valor antigo + aluguer*. Depois de instalar: abrir **Planos**, pôr o preço no valor certo, e usar **aplicar aos serviços ativos**. O diálogo mostra o impacto antes de escrever fosse o que for. Fazer uma cópia de segurança primeiro (Definições › Backups, um clique).

## [1.11.3](https://github.com/Harrydevcod/IspManager/releases/tag/v1.11.3) — 2026-08-14

### Corrigido

- **pagamentos:** "Em atraso" passa a ser quem tem a data de vencimento passada, e não só quem foi marcado à mão. O estado `overdue` nunca é escrito sozinho, por isso o cartão "Atraso" mostrava `0$00` em todos os meses e o filtro Atraso devolvia sempre uma lista vazia — os 14.000$ de dívida real estavam escondidos dentro de "Pendente". A etiqueta de cada linha acompanha, e o lembrete de WhatsApp/SMS deixa de mandar "fatura emitida" a quem já está semanas em atraso

## [1.11.2](https://github.com/Harrydevcod/IspManager/releases/tag/v1.11.2) — 2026-08-14

### Corrigido

- **pagamentos:** Os totais Pendente / Atraso / Pago deixam de seguir o filtro de estado. O ecrã abre filtrado a Pendente, por isso os outros dois estavam a zero desde sempre — e trocar de estado zerava os restantes. Servem para comparar as três parcelas do período, agora comparam. Continuam a respeitar o mês e a pesquisa; a lista e o seu contador seguem todos os filtros, como antes

## [1.11.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.11.1) — 2026-08-14

### Corrigido

- **cobranca:** O que está vencido passa a contar-se pela data e não pelo estado. O painel principal contava só os pagamentos marcados em atraso à mão — ninguém marca — por isso anunciava "Sem alertas criticos" com 14.000$ vencidos na carteira, enquanto o painel Operação, que já contava pela data, gritava crítico. Os dois painéis, o relatório de Atrasos e os avisos de WhatsApp passam a partilhar a mesma definição
- **planos:** A lista mostrava a velocidade duas vezes ("20 Mb/s/20Mb/s") porque juntava o texto antigo em vez de usar os Mbps do plano
- **app:** Abrir o atalho com a aplicação já aberta deixava um processo pendurado a disputar a mesma base de dados — agora traz a janela existente para a frente

## [1.11.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.11.0) — 2026-08-14

### Adicionado

- **rede:** Controlo de acesso no MikroTik — suspender um serviço no ISPM passa a cortar o cliente no router, e reativar repõe-no, sem ninguém abrir o Winbox. O ISPM decide (base de dados) e o router executa (realidade): uma passagem periódica compara os dois e aplica a diferença, com a sessão viva derrubada no corte para o cliente não ficar online até reconectar. Um serviço novo nasce com utilizador e senha PPPoE, e o router recebe-os na passagem seguinte; mudar de plano acerta a velocidade sozinho. Liga-se em Definições → Rede e **vem em ensaio**: até alguém desligar o ensaio, o ISPM só mostra o que faria. Trava de segurança contra cortes em massa (cinco por passagem, por omissão), divergências reportadas em vez de sobrepostas em silêncio, e cada corte deixa rasto na auditoria e no histórico do cliente
- **planos:** Campos de velocidade em Mbps, ao lado do texto que já existia. É deste número que sai o limite aplicado no router — em branco, o router fica como está, porque uma velocidade adivinhada a partir de texto livre é um cliente estrangulado sem se perceber porquê
- **rede:** Sonda de disponibilidade — o ISPM passa a fazer ping periódico aos equipamentos com IP registado e a dizer quais estão de pé. Um equipamento só se declara em baixo ao fim de três falhas seguidas (um ping perdido numa ligação rádio é normal, não é avaria) e volta a subir à primeira resposta. Liga-se em Definições → Rede, com intervalo, limiar de falhas e a opção de sondar também as CPEs dos clientes; há um botão "Testar agora" para experimentar antes de ligar. **Só lê a rede** — não altera nada em nenhum equipamento
- **relatorios:** Cartão "Disponibilidade" no painel Operação, e a queda passa a ser conclusão a vermelho com o número de clientes e o MRR que ficam por trás. Um equipamento que anda a cair e a voltar aparece a amarelo, antes de se avariar de vez
- **topologia:** O nó do mapa mostra a última leitura da sonda — ponto verde de pé, vermelho sem resposta. Sem leitura não há ponto: o que não foi medido não se pinta de verde

A disponibilidade é contada sobre o tempo **observado**: a sonda só corre com a aplicação aberta, e as horas em que ninguém mediu não contam nem como rede de pé nem como avaria.
### Alterado

- **serviços:** Suspender, reativar ou cancelar um serviço passa a ficar registado na história do cliente, com data e motivo. Até aqui o estado era só mais um campo do formulário: um serviço passava a suspenso em silêncio, e três meses depois ninguém sabia quando nem porquê. A cascata do cliente também passa a registar serviço a serviço

## [1.10.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.10.1) — 2026-08-11

### Adicionado

- **licenciamento:** A aplicação passa a validar a licença. Sem licença há **30 dias de avaliação**; terminados, entra em **leitura-apenas** — consultar, exportar documentos e fazer cópias de segurança continua a funcionar, e os dados nunca ficam inacessíveis. Ativação em Definições → Licença, com o ficheiro fornecido na compra. Uma licença perpétua nunca expira: o que caduca é o direito a atualizações

### Corrigido

- **instalador:** As builds de macOS e Linux voltam a sair. O contrato de licença em português fazia o empacotamento do DMG falhar, porque o macOS não traz rótulos de botões para português; o contrato passa a ser declarado só onde é usado, no instalador Windows
- **instalador:** Publicar a etiqueta de versão antes de criar a release deixa de deitar abaixo as builds de macOS e Linux

## [1.10.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.10.0) — 2026-08-11

### Adicionado

- **relatorios:** Aba "Operacao" — o estado da operação inteiro numa leitura: cobrança, rede, parque, canais, acesso e sistema. É a vista que abre o módulo, porque é a que responde à pergunta com que se abre um relatório: o que exige decisão agora
- **relatorios:** Riscos e próximas ações derivados dos dados a cada leitura, e não de uma lista fixa — resolvido o problema, a linha desaparece sozinha. Cada um traz a exposição em escudos, para se saber o que custa não decidir
- **relatorios:** PDF mensal do estado da operação, para arquivo

### Alterado

- **relatorios:** O painel lê-se vivo — atualiza sozinho a cada 30 segundos e revalida ao voltar à janela. Uma falha de leitura deixa de apagar o painel: mostra a última leitura válida com o aviso por cima
- **aparencia:** Tema escuro reescrito em azul-tinta. Sobre um fundo escuro a sério os cartões e os gráficos destacam-se sem precisarem de sombra, e o laranja da empresa entra como segundo eixo ao lado do azul. O tema claro fica exatamente como estava

### Corrigido

- **dashboard:** Os cartões deixam de abrir grandes espaços pretos. A grelha tinha três colunas para dois cartões, o que deixava sempre um terço da linha vazio, e o cartão mais curto acabava a meio da linha em vez de acompanhar o vizinho. Os estados vazios passam a ser desenhados em vez de uma frase solta no escuro
- **aparencia:** O arranque deixa de piscar a cor antiga antes de assentar no tema

## [1.9.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.9.0) — 2026-08-02

### Adicionado

- **topologia:** Ver o mapa por antena — o backbone escolhido, as CPEs que pendem dele e a cadeia até à Internet, a partir do seletor da barra, do inspetor ou da lista de backbones. A rede inteira não cabe legível num ecrã; uma antena de cada vez cabe
- **topologia:** Agregação multi-WAN — um equipamento pode somar vários links a montante, e o mapa mostra de onde vem cada um
- **topologia:** Contador "Sem equipamento" — os serviços ativos sem CPE não existem no mapa e não são "sem ligação"; é o motivo nº1 para um cliente não aparecer
- **topologia:** Botão Atualizar no mapa, que recarrega sem fechar os ramos abertos

### Alterado

- **topologia:** O mapa abre de cima para baixo e com o inspetor fechado — o painel só entra na primeira seleção
- **topologia:** O módulo devolve o espaço ao mapa: o título saiu, os números passam a uma tira de uma linha e as ferramentas flutuam sobre o canvas
- **topologia:** A ilha deixa de ser texto livre em todos os pontos de entrada, incluindo a importação de clientes

### Corrigido

- **topologia:** O mapa passa a enquadrar-se de facto — abre com a rede à vista e reenquadra ao abrir ou fechar ramos
- **topologia:** O minimapa deixa de desenhar o grafo para fora da própria caixa e de desaparecer em janelas estreitas
- **topologia:** O mapa deixa de mostrar uma fotografia velha da rede depois de instalar equipamento noutro módulo

## [1.8.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.8.0) — 2026-07-31

### Adicionado

- **topologia:** Novo módulo com as abas Backbone e Topologia — a rede física mapeada da Internet para baixo, cada equipamento ligado ao que o alimenta
- **topologia:** Mapa com zoom pela roda do rato, orientação horizontal ou vertical, ramos que abrem e fecham a partir de um só controlo e inspetor recolhível para o mapa ocupar o ecrã todo
- **topologia:** Registar e ligar equipamento a partir do próprio mapa, por arrasto
- **interface:** Barra lateral recolhível para uma calha de ícones

### Alterado

- **marca:** Ícone da aplicação redesenhado como a corrente do backbone, em grafite e ouro
- **stock:** As quantidades de backbone deixam de viver no catálogo e passam a sair das ligações físicas reais

### Corrigido

- **stock:** A gravação de equipamento diz qual é o campo que a impede
- **topologia:** O mapa deixa de transbordar da caixa e de cortar a legenda

## [1.7.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.7.1) — 2026-07-28

### Alterado

- **interface:** Ações dos cabeçalhos de módulo com hierarquia semântica — uma só ação principal por ecrã, secundárias em tom neutro frio, primárias em grafite editorial no tema claro e azul ISPM no escuro

## [1.7.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.7.0) — 2026-07-28

### Adicionado

- **serviços:** IP fixo dos equipamentos visível na lista, no detalhe e na pesquisa — escrever um IP no filtro encontra o cliente daquela antena
- **serviços:** Editar a identificação de um equipamento instalado (IP, MAC, serial, tag) sem consumir stock
- **serviços:** Ecrã "Atribuir IPs" para preencher todos os equipamentos de uma vez, com busca e filtro por preencher
- **serviços:** Prefixo de IP sugerido a partir da rede já instalada
- **serviços:** Uma antena pode servir vários clientes (prédio com switch, antena com várias saídas de rede), sem duplicar stock e com o custo dividido pelos serviços servidos

### Alterado

- **clientes/serviços/pagamentos:** As listas abrem filtradas pelos estados ativos
- **serviços:** IP fixo só se aplica a antenas e pontos de acesso; routers de cliente usam IP dinâmico
- **serviços:** IPs são validados como IPv4 e recusados quando já pertencem a outro equipamento ativo

### Corrigido

- **serviços:** Campo de IP transbordava para fora do cartão no ecrã de atribuição

## [1.6.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.6.0) — 2026-07-21

### Adicionado

- **financeiro:** Taxa de instalação faturada ao criar serviço
- **dashboard:** Clique num mês do gráfico abre Pagamentos desse mês (#79)

### Alterado

- **financeiro:** Coluna Ações encostada à borda sem hack de margem

## [1.5.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.5.0) — 2026-07-14

### Adicionado

- **sms:** Relatório mensal de entregas de SMS (#78)

## [1.4.9](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.9) — 2026-07-06

### Adicionado

- **financeiro:** Ações de Pagamentos colapsadas num menu ⋯ por linha

## [1.4.8](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.8) — 2026-07-06

### Adicionado

- **financeiro:** Pagamentos passa a primeira aba do módulo Financeiro (#77)

## [1.4.7](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.7) — 2026-07-05

### Adicionado

- **financeiro:** Auditoria leva 2 — laranja (médias/rateio/ROI/timeline) + amarelos (zonas/CAPEX/defaults/sync) (#76)
- **build:** App multiplataforma — Linux AppImage no pipeline de builds (#74)
- **build:** Build macOS via GitHub Actions (DMG arm64 + Intel) (#72)

### Corrigido

- **financeiro:** Motor de atribuição sem dupla contagem + recuperação real + catch-up de despesas (#75)
- **ci:** Dispatch do build mac compila main + tag via env (injection) (#73)

## [1.4.6](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.6) — 2026-07-04

### Adicionado

- **app:** Novidades desta versão no design system + versão correta em dev (#71)
- **app:** Notas das versões privadas — link removido + Novidades in-app (#70)

## [1.4.5](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.5) — 2026-07-04

### Adicionado

- **dashboard:** Contagem do Pendente do mês por vencimento (#69)

## [1.4.4](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.4) — 2026-07-04

### Corrigido

- **dashboard:** Pendente do mês em base de vencimento (#68)

## [1.4.3](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.3) — 2026-07-04

### Adicionado

- **app:** Diálogo de atualização profissional + menu Sobre com versão visível (#67)

## [1.4.2](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.2) — 2026-07-03

### Adicionado

- **ui:** Ícone da app no lugar da letra I (sidebar + auth) (#66)

## [1.4.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.1) — 2026-07-03

### Corrigido

- **dashboard:** Receita do mês em regime de caixa (#65)

## [1.4.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.0) — 2026-07-03

### Adicionado

- **theme:** Dark mais claro + acrílico Win11 (#63)
- **ui:** Redesign backups, tema Windows-aware e ilhas fechadas (#62)

### Corrigido

- **reports:** Arruma e estiliza a secção Incompletos (#64)

## [1.3.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.3.0) — 2026-07-02

### Adicionado

- **setup:** Primeiro arranque permite restaurar backup em vez de criar admin (#61)

## [1.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.2.1) — 2026-07-02

### Corrigido

- **dashboard:** Tiles do rail com valor por extenso (131.000$00, não 131k$) (#60)

## [1.2.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.2.0) — 2026-07-02

### Corrigido

- **payments:** Downloads/impressão de PDF, faturação de mês fechado e validação de datas (#59)

## [1.1.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.1.0) — 2026-06-30

### Adicionado

- **ui:** Tile do rail mostra receita acumulada total (#57)
- **ui:** Pendente acumulado como tile do comando operacional (#56)
- **ui:** Pendente acumulado movido para comando operacional (#54)
- **ui:** Card "Pendente acumulado" no dashboard (meses anteriores) (#53)
- **ui:** Dashboard com Receita pendente e brief operacional com sinais (#48)

### Corrigido

- **ui:** Remove card "Planos ativos" do dashboard (#52)
- **ui:** Remove duplicação do alerta de stock baixo no dashboard (#51)
- **ui:** Brief operacional empilha banner em cima e tiles em baixo (#50)
- **ui:** Encurta texto de estado vazio em Financeiro/Lucro (#49)

## [1.0.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.0.0) — 2026-06-29

### Adicionado

- **ui:** Polish #8 — estados de carregamento nos módulos restantes (#39)
- **ui:** Skeleton de carregamento nos módulos de lista (+ nota #9) (#38)
- **ui:** Cheat-sheet de atalhos de teclado (tecla ?) (#37)
- **ui:** Ações em massa nos clientes (notificar / mudar estado) (#36)
- **ui:** Ações em massa nos pagamentos (seleção múltipla) (#35)
- **ui:** Tabelas com ordenação, header sticky e paginação (#34)
- **dashboard:** KPIs e alertas viram atalhos navegáveis (#33)
- **ui:** Autofocus no 1º campo ao abrir diálogos
- **ui:** Rollout do ErrorRetry a todos os módulos de dados
- **ui:** Skeletons de loading + erro com retry; consolida escala de espaçamento
- **ui:** Escala de espaçamento --space-* e normalização
- **ui:** Reverifica a saúde da API a cada 15s

### Corrigido

- **ui:** Colunas dos Pagamentos sempre alinhadas (ações largura fixa) (#47)
- **ui:** Não repetir "Fatura"/"Recibo" quando o número já traz FT/RC (#44)
- **security:** Endurece o save path do download contra path traversal (#43)
- **download:** Documentos guardam com nome informativo, não UUID aleatório (#42)
- **ui:** Número de fatura/recibo aparecia com prefixo duplicado (#41)
- **ui:** Célula de identidade na tabela voltava a colar código/nome/meta (#40)

## [0.4.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.4.0) — 2026-06-28

### Adicionado

- **stock:** Backbone por quantidade em vez de flag booleana
- **stock:** Distingue equipamento de backbone do de cliente

## [0.3.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.3.1) — 2026-06-27

### Adicionado

- **updater:** Auto-update via GitHub Releases + build.publish

## [0.3.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.3.0) — 2026-06-27

### Adicionado

- **db:** Cobre tabelas 0020/0022/0023 no schema Drizzle
- **db:** Schema Drizzle completo + guarda de drift contra as migrations
- **dunning:** Funil de cobrança configurável com timeline no cliente
- **backup:** Observabilidade do backup agendado via runJob
- **backup:** Configuração de backups no ecrã (pasta + agendamento)
- **backup:** Backups agendados + pasta de destino configurável
- **jobs:** Painel de saúde dos automatismos nas Configurações
- **jobs:** Regista execuções dos jobs in-process (tabela job_runs)
- **auth:** Rate-limiting e lockout exponencial no login
- **money:** Modulo partilhado de dinheiro + formatacao cifrao (1.500$00)
- **faturacao:** Numeracao sequencial real por serie/ano dos documentos

### Alterado

- **renderer:** Extrai abas de configuracoes em componentes
- **renderer:** Extrai ServiceItemDraftsBuilder de servicos
- **renderer:** Extrai ServiceDetailDialog de servicos
- **renderer:** Extrai PaymentsList de pagamentos
- **renderer:** Extrai PaymentDetailDialog de pagamentos
- **renderer:** Extrai dialogs de pagamentos
- **renderer:** Extrai componentes de pagamentos
- **documents:** Move geração de PDF para lib/documents
- **finance:** Extrai regra de serviços para lib/services
- **finance:** Extrai regra do ciclo de pagamentos para lib/payments

## [0.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.1) — 2026-06-25

### Corrigido

- **build:** Empacota better-sqlite3 na ABI do Electron (app não abria)

## [0.2.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.0) — 2026-06-24

### Adicionado

- **servicos:** Mensalidade mostra total NET + TVM numa linha
- **servicos:** Apagar serviço mal criado (bloqueio fiscal + reposição de stock)
- **servicos:** Serviço de Distribuição de Conteúdos Audiovisuais (add-on + standalone)

### Corrigido

- **faturacao:** Regenerar mensalidade preserva o valor audiovisual no total
- **build:** Compila deps nativas do fonte e fixa Electron 41.7.0

## [0.1.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.1.1) — 2026-06-18

- **Versão inicial** do ISPM.
